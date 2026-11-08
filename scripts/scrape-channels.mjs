#!/usr/bin/env node
/**
 * Refreshes data/channels.json + data/seed-data.csv from the encrypted feed mirror.
 *
 *   node scripts/scrape-channels.mjs --out data/channels.json --csv data/seed-data.csv
 *
 * Outputs
 *   data/channels.json  – `{ version, generatedAt, channels: [...] }` catalog.
 *   <csv>               – same catalog as a seed CSV (Postgres-friendly).
 *   reports/…           – per-source stats and errors, uploaded as a CI artifact.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
  buildCatalog,
  catalogSummary,
  channelsFromJsonDocument,
  sameCatalogContent,
  toJsonDocument,
  toSeedCsv,
  validateCatalog,
} from './lib/catalog.mjs';
import { DEFAULT_USER_AGENT, probeStream } from './lib/http.mjs';
import { hostSummary, runSource } from './lib/sources.mjs';
import {
  errorAnnotation,
  formatDuration,
  log,
  logGroup,
  mapLimit,
  parseArgs,
  urlKey,
  warnAnnotation,
} from './lib/util.mjs';

const DEFAULTS = {
  config: 'config/scrape-sources.json',
  out: 'data/channels.json',
  report: 'reports/scrape-report.json',
  minChannels: 20,
  maxDropRatio: 0.4,
};

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
  log.info(`  wrote ${filePath} (${(contents.length / 1024).toFixed(1)} kB)`);
}

function sourceTable(results) {
  const rows = results.map((result) => ({
    source: result.id,
    kind: result.kind,
    role: result.role,
    status: result.ok ? 'ok' : 'failed',
    channels: result.channels.length,
    time: formatDuration(result.ms),
    note: result.error ?? '',
  }));
  const width = (key) => Math.max(key.length, ...rows.map((row) => String(row[key]).length));
  const widths = { source: width('source'), kind: width('kind'), role: width('role'), status: width('status'), channels: width('channels'), time: width('time') };
  const line = (row) =>
    [
      String(row.source).padEnd(widths.source),
      String(row.kind).padEnd(widths.kind),
      String(row.role).padEnd(widths.role),
      String(row.status).padEnd(widths.status),
      String(row.channels).padStart(widths.channels),
      String(row.time).padStart(widths.time),
      row.note,
    ]
      .join('  ')
      .trimEnd();

  return [line({ source: 'source', kind: 'kind', role: 'role', status: 'status', channels: 'count', time: 'time', note: '' }), ...rows.map(line)].join('\n');
}

/**
 * Probes every stream URL of the given channels and keeps only the ones that
 * really answer with an HLS/DASH manifest. Dead primaries are replaced by a
 * healthy backup server; channels with no working stream are dropped.
 */
async function verifyStreams(channels, options) {
  const { concurrency, timeoutMs, userAgent, scope, allowPrivateHosts = false } = options;
  const stats = { checked: 0, okay: 0, failed: 0, droppedChannels: 0, promoted: 0, scope };
  const cache = new Map();

  const urls = new Map();
  for (const channel of channels) {
    for (const url of [channel.url, ...channel.sources.map((source) => source.url)]) {
      const key = urlKey(url);
      if (!key || urls.has(key)) continue;
      urls.set(key, { url, referer: channel.referer, origin: channel.origin });
    }
  }
  stats.checked = urls.size;
  if (!urls.size) return { channels, stats };

  await mapLimit([...urls.entries()], concurrency, async ([key, target]) => {
    const result = await probeStream(target.url, {
      timeoutMs,
      userAgent,
      referer: target.referer,
      origin: target.origin,
      allowPrivateHosts,
    });
    cache.set(key, result);
    if (result.ok) stats.okay += 1;
    else stats.failed += 1;
  });

  const alive = (url) => cache.get(urlKey(url))?.ok === true;
  const survivors = [];

  for (const channel of channels) {
    const backup = channel.sources.filter((source) => alive(source.url));
    if (alive(channel.url)) {
      channel.sources = backup;
      survivors.push(channel);
      continue;
    }
    if (backup.length > 0) {
      const [promoted] = backup;
      channel.url = promoted.url;
      channel.referer = promoted.referer ?? channel.referer;
      channel.origin = promoted.origin ?? channel.origin;
      channel.sources = backup.slice(1);
      stats.promoted += 1;
      survivors.push(channel);
      continue;
    }
    stats.droppedChannels += 1;
  }

  return { channels: survivors, stats };
}

function githubSummary({ results, summary, probeStats, outPath, csvPath, durationMs, dryRun }) {
  const lines = [
    `## Channel catalog ${dryRun ? '(dry run)' : 'refreshed'}`,
    '',
    `- channels: **${summary.channels}**`,
    `- backup sources: **${summary.sources}**`,
    `- categories: **${summary.categories}**`,
    `- stream probes: ${probeStats.checked} checked / ${probeStats.okay} alive / ${probeStats.failed} dead`,
    `- dropped channels (no working stream): ${probeStats.droppedChannels}`,
    `- duration: ${formatDuration(durationMs)}`,
    '',
    '| source | kind | status | channels |',
    '| --- | --- | --- | --- |',
    ...results.map(
      (result) => `| ${result.id} | ${result.kind} | ${result.ok ? 'ok' : `failed: ${result.error}`} | ${result.channels.length} |`,
    ),
    '',
    `updated: \`${outPath}\`${csvPath ? `, \`${csvPath}\`` : ''}`,
  ];
  return `${lines.join('\n')}\n`;
}

async function main() {
  const startedAt = Date.now();
  const args = parseArgs();
  const dryRun = args.dryRun === true;

  const configPath = typeof args.config === 'string' ? args.config : DEFAULTS.config;
  const config = await readJson(configPath).catch((error) => {
    throw new Error(`cannot read config ${configPath}: ${error.message}`);
  });

  const outPath = typeof args.out === 'string' ? args.out : config.output?.json ?? DEFAULTS.out;
  const csvArg = typeof args.csv === 'string' ? args.csv : config.output?.csv ?? '';
  const csvPath = csvArg && csvArg !== 'false' ? csvArg : null;
  const reportPath = args.report === false ? null : typeof args.report === 'string' ? args.report : DEFAULTS.report;

  const userAgent = config.userAgent || DEFAULT_USER_AGENT;
  const ctx = {
    userAgent,
    categoryRules: Array.isArray(config.categoryRules) ? config.categoryRules : [],
    respectRobots: config.respectRobots !== false,
    concurrency: Math.max(1, Number(args.concurrency ?? config.concurrency ?? 4)),
    fetchOptions: {
      timeoutMs: Number(config.timeoutMs ?? 20_000),
      retries: Number(config.retries ?? 1),
      // Local/offline testing only — never enable this in the scheduled workflow.
      allowPrivateHosts: config.allowPrivateHosts === true && args.allowPrivateHosts !== false,
    },
  };

  const allSources = (Array.isArray(config.sources) ? config.sources : []).filter((source) => source && source.enabled !== false);
  const selected = allSources;
  if (!selected.length) throw new Error(`no enabled sources in ${configPath}`);

  // An explicit CLI flag wins over the config file (`--merge-existing` / `--no-merge-existing`).
  const mergeExisting = typeof args.mergeExisting === 'boolean' ? args.mergeExisting : config.mergeExisting !== false;
  const previousDocument = await readJsonIfExists(outPath);
  const previousCsv = csvPath ? await fs.readFile(csvPath, 'utf8').catch(() => null) : null;
  const existing = mergeExisting && previousDocument ? channelsFromJsonDocument(previousDocument, 'existing') : [];

  log.info(`Scraping ${selected.length} source(s) — existing catalog: ${existing.length} channels`);
  log.blank();

  const results = await mapLimit(selected, 2, async (source) => {
    const close = logGroup(`source: ${source.id} (${source.kind})`);
    const result = await runSource(source, ctx);
    if (result.ok) {
      log.ok(`${source.id}: ${result.channels.length} channels in ${formatDuration(result.ms)}`);
    } else {
      warnAnnotation(`${source.id} failed: ${result.error}`);
    }
    close();
    return result;
  });

  log.blank();
  log.info(sourceTable(results));
  log.blank();

  const baseline = results.filter((result) => result.ok && result.role === 'baseline').flatMap((result) => result.channels);
  const scraped = results.filter((result) => result.ok && result.role !== 'baseline').flatMap((result) => result.channels);

  if (!baseline.length && !scraped.length && !existing.length) {
    throw new Error('every source failed and there is no previous catalog to keep');
  }

  const probeConfig = config.probe ?? {};
  const probeEnabled = args.noProbe ? false : args.probe ? true : probeConfig.enabled !== false;
  const probeScope = args.probeScope ?? probeConfig.scope ?? 'scraped';
  const probeTargets = probeScope === 'all' ? [...baseline, ...scraped] : scraped;
  const probeKept = new Set(probeTargets);

  let probeStats = { checked: 0, okay: 0, failed: 0, droppedChannels: 0, promoted: 0, scope: probeScope, enabled: false };
  let verifiedTargets = probeTargets;

  if (probeEnabled && probeTargets.length) {
    log.info(`Probing streams for ${probeTargets.length} scraped channel(s)…`);
    const verified = await verifyStreams(probeTargets, {
      concurrency: Math.max(1, Number(args.probeConcurrency ?? probeConfig.concurrency ?? 8)),
      timeoutMs: Number(probeConfig.timeoutMs ?? 12_000),
      userAgent,
      scope: probeScope,
      allowPrivateHosts: ctx.fetchOptions.allowPrivateHosts === true,
    });
    probeStats = { ...verified.stats, enabled: true };
    verifiedTargets = verified.channels;
    log.ok(
      `probe: ${probeStats.checked} checked, ${probeStats.okay} alive, ${probeStats.failed} dead, ` +
        `${probeStats.promoted} promoted, ${probeStats.droppedChannels} channels dropped`,
    );
    log.blank();
  }
  void probeKept;

  const { channels, categories, stats: mergeStats } = buildCatalog({
    existing,
    baseline: probeScope === 'all' ? [] : baseline,
    scraped: verifiedTargets,
    categoryIds: config.categoryIds ?? {},
  });

  const document = toJsonDocument(channels);
  const validation = validateCatalog(document);

  const summary = catalogSummary(channels);
  const minChannels = Number(args.minChannels ?? config.guardrails?.minChannels ?? DEFAULTS.minChannels);
  const maxDropRatio = Number(args.maxDropRatio ?? config.guardrails?.maxDropRatio ?? DEFAULTS.maxDropRatio);
  const problems = [];

  for (const error of validation.errors.slice(0, 25)) problems.push(`validation: ${error}`);
  if (channels.length < minChannels) problems.push(`only ${channels.length} channels (< min ${minChannels})`);
  if (existing.length > 0 && channels.length < existing.length * (1 - maxDropRatio)) {
    problems.push(`catalog shrank from ${existing.length} to ${channels.length} channels (> ${(maxDropRatio * 100).toFixed(0)}% loss)`);
  }

  const durationMs = Date.now() - startedAt;
  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    durationMs,
    config: configPath,
    outputs: { json: outPath, csv: csvPath },
    sources: results.map((result) => ({
      id: result.id,
      kind: result.kind,
      role: result.role,
      ok: result.ok,
      ms: result.ms,
      error: result.error,
      channels: result.channels.length,
      stats: result.stats,
    })),
    probe: probeStats,
    merge: mergeStats,
    categories: categories.length,
    summary,
    hosts: hostSummary(channels),
    validation: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings.slice(0, 50) },
    problems,
  };

  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  log.info('Catalog');
  log.info(`  channels:   ${summary.channels}`);
  log.info(`  sources:    ${summary.sources} (${summary.withSources} channels have backups)`);
  log.info(`  categories: ${summary.categories}`);
  log.info(`  merged:     +${mergeStats.added} new / ~${mergeStats.merged} matched`);
  log.blank();
  log.info('Top categories');
  for (const [name, count] of Object.entries(summary.byCategory).slice(0, 8)) {
    log.info(`  ${String(count).padStart(4)}  ${name}`);
  }
  log.blank();

  if (validation.warnings.length) {
    warnAnnotation(`${validation.warnings.length} validation warning(s); first: ${validation.warnings[0]}`);
  }

  if (problems.length) {
    for (const problem of problems) errorAnnotation(problem);
    log.error(`Refusing to publish an unhealthy catalog (${problems.length} problem(s)).`);
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    log.info(`Dry run: nothing written except ${reportPath ?? 'report (disabled)'}.`);
    return;
  }

  const jsonContents = `${JSON.stringify(document, null, 2)}\n`;
  const csvContents = csvPath ? toSeedCsv(channels) : null;

  if (sameCatalogContent(previousDocument, document) && (!csvPath || csvContents === previousCsv)) {
    log.info(`No catalog changes since ${previousDocument?.generatedAt ?? 'the previous run'} — files left untouched.`);
  } else {
    if (!sameCatalogContent(previousDocument, document)) await writeFile(outPath, jsonContents);
    if (csvPath && csvContents !== previousCsv) await writeFile(csvPath, csvContents);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const summaryMarkdown = githubSummary({ results, summary, probeStats, outPath, csvPath, durationMs, dryRun });
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown, 'utf8');
  }

  log.blank();
  log.ok(`Catalog published in ${formatDuration(durationMs)}.`);
}

main().catch((error) => {
  errorAnnotation(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
