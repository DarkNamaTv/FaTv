import crypto from 'node:crypto';

/** Stable 31-bit integer derived from a string (never 0). */
export function sha1Int(input) {
  const digest = crypto.createHash('sha1').update(String(input)).digest();
  const value = digest.readUInt32BE(0) & 0x7fffffff;
  return value === 0 ? 1 : value;
}

/**
 * Normalized lookup key for a channel name.
 * Folds Arabic/Persian letter variants, drops zero-width joiners and punctuation
 * so "Gem TV", "gem-tv" and "جم تيوي" collapse onto predictable keys.
 */
export function nameKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200c\u200d\u200e\u200f\u00a0]/g, ' ')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[^0-9a-z\u0600-\u06ff]+/g, '');
}

/** Normalized lookup key for a stream URL: host + path, no www, no query, no trailing slash. */
export function urlKey(value) {
  try {
    const url = new URL(String(value).trim());
    if (!/^https?:$/i.test(url.protocol)) return '';
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return `${host}${path}`;
  } catch {
    return '';
  }
}

export function hostOf(value) {
  try {
    return new URL(String(value)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/** Concurrency limiter: `const run = createLimiter(4); await run(() => task())`. */
export function createLimiter(max = 4) {
  const limit = Math.max(1, Number(max) || 1);
  let active = 0;
  const queue = [];

  const pump = () => {
    while (active < limit && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
}

export async function mapLimit(items, limit, worker) {
  const run = createLimiter(limit);
  return Promise.all(items.map((item, index) => run(() => worker(item, index))));
}

export function bool(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

export function int(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function text(value) {
  return typeof value === 'string' ? value.trim() : value === 0 ? '0' : '';
}

export function nullable(value) {
  const result = text(value);
  return result ? result : null;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms));
  if (total < 1000) return `${total} ms`;
  if (total < 60_000) return `${(total / 1000).toFixed(1)} s`;
  return `${Math.floor(total / 60_000)}m ${Math.round((total % 60_000) / 1000)}s`;
}

const isCI = Boolean(process.env.GITHUB_ACTIONS);

export const log = {
  info: (message) => console.log(message),
  ok: (message) => console.log(`✓ ${message}`),
  warn: (message) => console.warn(`! ${message}`),
  error: (message) => console.error(`✗ ${message}`),
  blank: () => console.log(''),
};

/** Collapsible log group under GitHub Actions, plain output elsewhere. */
export function logGroup(title) {
  if (isCI) console.log(`::group::${title}`);
  else console.log(`── ${title}`);
  return () => {
    if (isCI) console.log('::endgroup::');
  };
}

export function warnAnnotation(message) {
  if (isCI) console.log(`::warning::${String(message).replace(/\r?\n/g, ' ')}`);
  else log.warn(message);
}

export function errorAnnotation(message) {
  if (isCI) console.log(`::error::${String(message).replace(/\r?\n/g, ' ')}`);
  else log.error(message);
}

/** Minimal argv parser: `--out file` / `--out=file` / `--dry-run` / `--no-merge`. */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const body = token.slice(2);
    if (body.includes('=')) {
      const [key, ...rest] = body.split('=');
      args[toCamel(key)] = rest.join('=');
      continue;
    }
    if (body.startsWith('no-')) {
      args[toCamel(body.slice(3))] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[toCamel(body)] = next;
      i += 1;
    } else {
      args[toCamel(body)] = true;
    }
  }
  return args;
}

function toCamel(value) {
  return value.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}
