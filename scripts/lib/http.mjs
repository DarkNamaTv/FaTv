import net from 'node:net';
import { sleep } from './util.mjs';

export const DEFAULT_USER_AGENT =
  'TVScrap-CatalogBot/1.0 (+https://github.com/DarkNamaTv/FaTv)';

const MAX_BODY_BYTES = 6 * 1024 * 1024;

function isPrivateIp(value) {
  const version = net.isIP(value);
  if (version === 4) {
    const [a, b] = value.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (version === 6) {
    const normalized = value.toLowerCase();
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:')
    );
  }
  return false;
}

/** Blocks non-HTTP(S) schemes and private/loopback hosts before any request is made. */
export function isPublicHttpUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return false;
  }
  if (!/^https?:$/i.test(url.protocol)) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    return false;
  }
  if (net.isIP(host)) return !isPrivateIp(host);
  return true;
}

const robotsCache = new Map();

function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      if (value) current.rules.push({ allow: field === 'allow', path: value });
    }
  }
  return groups;
}

function ruleMatches(path, rulePath) {
  if (rulePath === '/') return true;
  const pattern = rulePath.replace(/\*/g, '.*').replace(/\$$/, '$');
  try {
    return new RegExp(`^${pattern}`).test(path);
  } catch {
    return path.startsWith(rulePath);
  }
}

async function loadRobots(origin, userAgent) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  const rules = { fetched: false, groups: [] };
  robotsCache.set(origin, rules);
  try {
    const response = await fetch(`${origin}/robots.txt`, {
      redirect: 'follow',
      headers: { 'user-agent': userAgent, accept: 'text/plain,*/*' },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      rules.groups = parseRobots(await response.text());
      rules.fetched = true;
    }
  } catch {
    // robots.txt unreachable: behave like a browser and continue.
  }
  return rules;
}

/**
 * Best-effort robots.txt check (longest matching rule wins, like Google's spec).
 * A missing/unreachable robots.txt allows everything.
 */
export async function robotsAllows(rawUrl, userAgent = DEFAULT_USER_AGENT) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const rules = await loadRobots(url.origin, userAgent);
  if (!rules.groups.length) return true;

  const token = userAgent.toLowerCase().split(/[/\s]/)[0];
  const applicable = rules.groups.filter(
    (group) => group.agents.includes('*') || group.agents.some((agent) => agent && token.includes(agent)),
  );
  if (!applicable.length) return true;

  const path = `${url.pathname}${url.search}` || '/';
  let decision = true;
  let bestLength = -1;
  for (const group of applicable) {
    for (const rule of group.rules) {
      if (!ruleMatches(path, rule.path)) continue;
      const length = rule.path.length;
      if (length > bestLength || (length === bestLength && rule.allow)) {
        bestLength = length;
        decision = rule.allow;
      }
    }
  }
  return decision;
}

/**
 * Polite text fetch: robots-aware, timeout-bound, retried with backoff.
 * Returns `{ text, url, status }` where `url` is the final URL after redirects.
 */
export async function fetchText(rawUrl, options = {}) {
  const {
    timeoutMs = 20_000,
    retries = 1,
    headers = {},
    accept = 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
    respectRobots = true,
    userAgent = DEFAULT_USER_AGENT,
    maxBytes = MAX_BODY_BYTES,
    allowPrivateHosts = false,
  } = options;

  if (!allowPrivateHosts && !isPublicHttpUrl(rawUrl)) throw new Error(`refusing non-public URL: ${rawUrl}`);
  if (respectRobots && !(await robotsAllows(rawUrl, userAgent))) {
    throw new Error(`blocked by robots.txt: ${rawUrl}`);
  }

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(750 * attempt + Math.floor(Math.random() * 400));
    try {
      const response = await fetch(rawUrl, {
        redirect: 'follow',
        headers: { 'user-agent': userAgent, accept, 'accept-language': 'fa,en;q=0.8', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${rawUrl}`);
      let text = await response.text();
      if (text.length > maxBytes) text = text.slice(0, maxBytes);
      return { text, url: response.url || rawUrl, status: response.status };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (/robots\.txt/.test(lastError.message)) break;
    }
  }
  throw lastError ?? new Error(`request failed: ${rawUrl}`);
}

/**
 * Stream probe: fetches the first bytes of a playlist/manifest and verifies it
 * really is a stream (HLS `#EXTM3U`, DASH XML or a redirect to one).
 */
export async function probeStream(rawUrl, options = {}) {
  const {
    timeoutMs = 12_000,
    userAgent = DEFAULT_USER_AGENT,
    referer = null,
    origin = null,
    respectRobots = false,
    expect = 'auto',
    allowPrivateHosts = false,
  } = options;

  if (!allowPrivateHosts && !isPublicHttpUrl(rawUrl)) return { ok: false, status: 0, latencyMs: 0, error: 'non-public URL' };

  const started = Date.now();
  const headers = {
    'user-agent': userAgent,
    accept: 'application/vnd.apple.mpegurl,application/x-mpegurl,application/dash+xml,*/*',
  };
  if (referer) headers.referer = referer;
  if (origin) headers.origin = origin;

  try {
    if (respectRobots && !(await robotsAllows(rawUrl, userAgent))) {
      return { ok: false, status: 0, latencyMs: Date.now() - started, error: 'blocked by robots.txt' };
    }
    const response = await fetch(rawUrl, {
      redirect: 'follow',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) return { ok: false, status: response.status, latencyMs, error: `HTTP ${response.status}` };

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const body = (await response.text()).slice(0, 4096);
    const looksLikeHls = body.includes('#EXTM3U');
    const looksLikeDash = /<MPD[\s>]/i.test(body);
    const looksHtml = /<html|<!doctype html/i.test(body);
    const okByType = contentType.includes('mpegurl') || contentType.includes('dash+xml');

    let ok;
    if (expect === 'hls') ok = looksLikeHls;
    else if (expect === 'dash') ok = looksLikeDash;
    else ok = looksLikeHls || looksLikeDash || (okByType && !looksHtml);

    return {
      ok,
      status: response.status,
      latencyMs,
      contentType,
      error: ok ? null : looksHtml ? 'responded with an HTML page' : 'no stream manifest in response',
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
