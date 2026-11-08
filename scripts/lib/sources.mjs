import { createDecipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { makeChannel } from './catalog.mjs';
import { cleanChannelName, guessNameFromUrl } from './extract.mjs';
import { fetchText } from './http.mjs';
import { hostOf, text } from './util.mjs';

/** First matching `categoryRules` entry wins; falls back to the source default. */
export function resolveCategory(source, haystack, ctx) {
  const rules = Array.isArray(source.categoryRules) ? source.categoryRules : Array.isArray(ctx.categoryRules) ? ctx.categoryRules : [];
  const probe = String(haystack ?? '');
  for (const rule of rules) {
    if (!rule || !rule.pattern) continue;
    try {
      if (!new RegExp(rule.pattern, 'i').test(probe)) continue;
      return {
        category: rule.category || source.category || 'Persian TV',
        categoryEn: rule.categoryEn || rule.category || source.categoryEn || source.category || 'Persian TV',
      };
    } catch {
      // a broken pattern must never abort the scrape
    }
  }
  return {
    category: source.category ?? 'Persian TV',
    categoryEn: source.categoryEn ?? source.category ?? 'Persian TV',
  };
}

async function fetchPage(url, source, ctx) {
  return fetchText(url, {
    timeoutMs: source.timeoutMs ?? ctx.fetchOptions.timeoutMs,
    retries: source.retries ?? ctx.fetchOptions.retries,
    respectRobots: source.respectRobots ?? ctx.respectRobots,
    userAgent: ctx.userAgent,
    allowPrivateHosts: ctx.fetchOptions.allowPrivateHosts === true,
  });
}

/* ------------------------------------------------------------------ *
 * mytvsat encrypted feed (My Online TV app backend mirror)
 * ------------------------------------------------------------------ */

/**
 * Normalizes one decrypted mytvsat/webservice payload (`{ posts: [...] }`).
 *
 * Upstream `channel_id` / `category_id` values are deliberately dropped: they live
 * in a small private numbering space that would block merging with the published
 * catalog, so identity comes from name + stream URL and categories are assigned
 * by name. Exported for reuse by scripts/import-mytvsat.mjs and tests.
 */
// Decryption scheme: base64 → AES-256-CBC → gzip → JSON.
export function tryAes256CbcJson(b64, key, iv) {
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    let out = Buffer.concat([decipher.update(Buffer.from(String(b64).trim(), 'base64')), decipher.final()]);
    if (out.length > 2 && out[0] === 0x1f && out[1] === 0x8b) out = gunzipSync(out);
    const json = JSON.parse(out.toString('utf8'));
    return json && typeof json === 'object' ? json : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeMytvsatPosts(document, source, ctx = {}) {
  const rows = Array.isArray(document) ? document : document?.posts;
  if (!Array.isArray(rows)) throw new Error('mytvsat payload has no posts array');
  const imageBase = String(source.imageBase || 'https://raw.githubusercontent.com/DarkNamaTv/FaTv/main/data/logos/').replace(/\/?$/, '/');
  const channels = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const name = cleanChannelName(text(row.channel_name))
      || cleanChannelName(text(row.channel_name_en))
      || cleanChannelName(guessNameFromUrl(row.channel_url))
      || 'Unknown channel';
    const nameEn = cleanChannelName(text(row.channel_name_en)) || name;
    const upstreamCategory = text(row.category_name_en);
    const category = upstreamCategory && upstreamCategory !== '?'
      ? { category: text(row.category_name) || upstreamCategory, categoryEn: upstreamCategory }
      : resolveCategory(source, `${name} ${nameEn} ${text(row.channel_url)}`, ctx);
    const rawImage = text(row.channel_image);
    const image = !rawImage ? null
      : /^https?:\/\//i.test(rawImage) ? rawImage : `${imageBase}${rawImage.replace(/^\/+/, '')}`;
    const channel = makeChannel(
      {
        name,
        nameEn,
        image,
        url: row.channel_url,
        referer: row.channel_referer,
        origin: row.channel_origin,
        vpn: row.need_vpn,
        iran: row.for_iran,
        vip: row.isvip,
        popular: row.popular,
        country: row.country,
        language: row.language,
        category: category.category,
        categoryEn: category.categoryEn,
        sources: Array.isArray(row.sourses)
          ? row.sourses.map((item) => ({
            title: item?.title ?? item?.name,
            url: item?.channel_url ?? item?.url,
            referer: item?.channel_referer ?? item?.referer,
            origin: item?.channel_origin ?? item?.origin,
            country: item?.country,
            vip: item?.isvip ?? item?.vip,
          }))
          : [],
      },
      source.id,
    );
    if (channel) channels.push(channel);
  }
  return channels;
}

async function readLocalOrFetch(url, source, ctx) {
  if (!/^https?:\/\//i.test(String(url || ''))) {
    const localPath = String(url || '').replace(/^file:\/\//, '');
    if (!localPath) throw new Error(`source "${source.id}" has no url`);
    return { text: await readFile(localPath, 'utf8'), finalUrl: localPath };
  }
  return fetchPage(url, source, ctx);
}

async function encryptedJson(source, ctx) {
  const stats = { bytes: 0, rows: 0 };
  const keyEnv = source.keyEnv || 'MYTVSAT_AES_KEY_HEX';
  const ivEnv = source.ivEnv || 'MYTVSAT_AES_IV_HEX';
  const keyHex = (process.env[keyEnv] || '').trim();
  const ivHex = (process.env[ivEnv] || '').trim();
  if (!keyHex || !ivHex) {
    throw new Error(`missing AES credentials for source "${source.id}" (set ${keyEnv} / ${ivEnv})`);
  }
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  if (key.length !== 32 || iv.length !== 16) {
    throw new Error(`invalid AES credentials for source "${source.id}": need 32-byte key + 16-byte IV hex`);
  }
  const page = await readLocalOrFetch(source.url, source, ctx);
  stats.bytes = page.text.length;
  const json = tryAes256CbcJson(page.text, key, iv);
  if (!json) throw new Error(`source "${source.id}" did not decrypt — wrong key or upstream format change?`);
  const channels = normalizeMytvsatPosts(json, source, ctx);
  stats.rows = channels.length;
  return { channels, stats };
}

export const ADAPTERS = {
  'encrypted-json': encryptedJson,
};

export function adapterFor(kind) {
  return ADAPTERS[String(kind ?? '').toLowerCase()] ?? null;
}

/**
 * Runs one configured source and normalizes its result.
 * Errors are captured in `stats` instead of aborting the whole run.
 */
export async function runSource(source, ctx) {
  const adapter = adapterFor(source.kind);
  const startedAt = Date.now();
  const result = {
    id: source.id,
    kind: source.kind,
    role: source.role ?? 'scraped',
    ok: false,
    ms: 0,
    channels: [],
    stats: {},
    error: null,
  };

  if (!adapter) {
    result.error = `unknown source kind: ${source.kind}`;
    result.ms = Date.now() - startedAt;
    return result;
  }

  try {
    const { channels, stats } = await adapter(source, ctx);
    result.channels = channels;
    result.stats = stats ?? {};
    result.ok = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  result.ms = Date.now() - startedAt;
  return result;
}

export function hostSummary(channels) {
  const hosts = new Map();
  for (const channel of channels) {
    const host = hostOf(channel.url);
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
  }
  return Object.fromEntries([...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15));
}
