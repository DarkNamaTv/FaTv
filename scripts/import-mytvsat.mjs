#!/usr/bin/env node
/**
 * One-shot import of the decrypted mytvsat payload (reports/apk-channels.json,
 * committed in the repo) into data/channels.json + data/seed-data.csv.
 *
 * Merges with the existing catalog exactly like a scrape run (same buildCatalog,
 * same guardrails, same writers) but skips stream probing — probing happens on
 * the next scheduled Action run.
 *
 *   node scripts/import-mytvsat.mjs [--dry-run] [--report <path>] [--payload posts]
 */
import fs from 'node:fs/promises';

import {
  buildCatalog,
  catalogSummary,
  channelsFromJsonDocument,
  sameCatalogContent,
  toJsonDocument,
  toSeedCsv,
  validateCatalog,
} from './lib/catalog.mjs';
import { normalizeMytvsatPosts } from './lib/sources.mjs';
import { log, parseArgs } from './lib/util.mjs';

async function main() {
  const args = parseArgs();
  const dryRun = args.dryRun === true;
  const reportPath = typeof args.report === 'string' ? args.report : 'reports/apk-channels.json';
  const payloadName = typeof args.payload === 'string' ? args.payload : 'posts';
  const outPath = typeof args.out === 'string' ? args.out : 'data/channels.json';
  const csvPath = typeof args.csv === 'string' ? args.csv : 'data/seed-data.csv';

  const config = JSON.parse(await fs.readFile('config/scrape-sources.json', 'utf8'));
  const source = (config.sources || []).find((s) => s.id === 'mytvsat')
    || { id: 'mytvsat', category: 'Persian TV', categoryEn: 'Persian TV' };
  const ctx = { categoryRules: config.categoryRules || [] };

  let report;
  try {
    report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${reportPath}: ${error.message} (reports are committed in the repo)`);
  }
  const payload = report.files?.[payloadName];
  if (!payload) throw new Error(`${reportPath} has no files["${payloadName}"]`);
  const scraped = normalizeMytvsatPosts(payload, source, ctx);
  log.ok(`${scraped.length} mytvsat channels normalized from ${payloadName}`);

  const previousDocument = await fs.readFile(outPath, 'utf8').then((raw) => JSON.parse(raw)).catch(() => null);
  const previousCsv = await fs.readFile(csvPath, 'utf8').catch(() => null);
  const existing = previousDocument ? channelsFromJsonDocument(previousDocument, 'existing') : [];

  const { channels, stats } = buildCatalog({ existing, scraped, categoryIds: config.categoryIds ?? {} });
  const document = toJsonDocument(channels);
  const validation = validateCatalog(document);
  const summary = catalogSummary(channels);

  const minChannels = Number(config.guardrails?.minChannels ?? 20);
  const maxDropRatio = Number(config.guardrails?.maxDropRatio ?? 0.4);
  const problems = [];
  for (const error of validation.errors.slice(0, 25)) problems.push(`validation: ${error}`);
  if (channels.length < minChannels) problems.push(`only ${channels.length} channels (< min ${minChannels})`);
  if (existing.length > 0 && channels.length < existing.length * (1 - maxDropRatio)) {
    problems.push(`catalog shrank from ${existing.length} to ${channels.length} channels (> ${(maxDropRatio * 100).toFixed(0)}% loss)`);
  }
  if (problems.length) {
    for (const problem of problems) log.error(problem);
    process.exitCode = 1;
    return;
  }
  for (const warning of validation.warnings.slice(0, 10)) log.info(`warning: ${warning}`);

  log.info(`merge: existing=${stats.existing} scraped=${stats.scraped} added=${stats.added} merged=${stats.merged} collapsed=${stats.duplicatesCollapsed ?? 0}`);
  log.info(`catalog: ${summary.channels} channels from ${summary.sources} source(s), ${summary.categories} categories`);
  if (dryRun) {
    log.info('Dry run: nothing written.');
    return;
  }

  const jsonContents = `${JSON.stringify(document, null, 2)}\n`;
  const csvContents = toSeedCsv(channels);
  if (sameCatalogContent(previousDocument, document) && csvContents === previousCsv) {
    log.info('No catalog changes — files left untouched.');
  } else {
    if (!sameCatalogContent(previousDocument, document)) await fs.writeFile(outPath, jsonContents, 'utf8');
    if (csvContents !== previousCsv) await fs.writeFile(csvPath, csvContents, 'utf8');
    log.ok(`wrote ${outPath} + ${csvPath}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
