import { bool, int, nameKey, nullable, sha1Int, text, urlKey } from './util.mjs';

/** Column order of the seed CSV export (`data/seed-data.csv`). */
export const CSV_HEADER = [
  'channel_id',
  'category_id',
  'channel_name',
  'channel_name_en',
  'channel_image',
  'channel_url',
  'channel_referer',
  'channel_agent',
  'channel_origin',
  'need_vpn',
  'for_iran',
  'popular',
  'isvip',
  'category_name',
  'category_name_en',
  'channel_headers',
  'sourses',
];

export const ID_RANGES = {
  channel: { min: 10_000, max: 999_999 },
  source: { min: 1_000_000, max: 9_999_999 },
  category: { min: 1000, max: 9999 },
};

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

function isHttpUrl(value) {
  return /^https?:\/\/[^\s]+$/i.test(String(value ?? '').trim());
}

function toId(...values) {
  for (const value of values) {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function makeSource(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = text(raw.url ?? raw.channel_url ?? raw.channelUrl);
  if (!isHttpUrl(url)) return null;
  return {
    id: toId(raw.id, raw.ID),
    title: nullable(raw.title ?? raw.name),
    url,
    referer: nullable(raw.referer ?? raw.channel_referer),
    origin: nullable(raw.origin ?? raw.channel_origin),
    country: nullable(raw.country),
    vip: bool(raw.vip ?? raw.isvip),
  };
}

/** Builds the internal channel record used everywhere inside the scraper. */
export function makeChannel(raw, sourceId = 'unknown') {
  if (!raw || typeof raw !== 'object') return null;
  const url = text(raw.url ?? raw.channel_url);
  if (!isHttpUrl(url)) return null;

  const name = text(raw.name ?? raw.channel_name) || text(raw.nameEn ?? raw.channel_name_en);
  const nameEn = text(raw.nameEn ?? raw.channel_name_en) || name;
  if (!name && !nameEn) return null;

  const sources = [];
  const seen = new Set();
  for (const candidate of Array.isArray(raw.sources) ? raw.sources : Array.isArray(raw.sourses) ? raw.sourses : []) {
    const source = makeSource(candidate);
    if (!source) continue;
    const key = urlKey(source.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
  }

  return {
    id: toId(raw.id, raw.channel_id, raw.ID),
    categoryId: int(raw.categoryId ?? raw.category_id, 0),
    name: name || nameEn,
    nameEn: nameEn || name,
    image: nullable(raw.image ?? raw.channel_image),
    url,
    referer: nullable(raw.referer ?? raw.channel_referer),
    origin: nullable(raw.origin ?? raw.channel_origin),
    vpn: bool(raw.vpn ?? raw.need_vpn),
    iran: bool(raw.iran ?? raw.for_iran),
    vip: bool(raw.vip ?? raw.isvip),
    popular: Math.max(0, int(raw.popular, 0)),
    country: nullable(raw.country),
    language: nullable(raw.language),
    category: text(raw.category ?? raw.category_name),
    categoryEn: text(raw.categoryEn ?? raw.category_name_en) || text(raw.category ?? raw.category_name),
    sources,
    scrapedFrom: Array.isArray(raw.scrapedFrom) ? [...raw.scrapedFrom] : [sourceId],
  };
}

export function makeChannels(list, sourceId) {
  return (Array.isArray(list) ? list : []).map((item) => makeChannel(item, sourceId)).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Python literal parsing (the `sourses` column is a Python repr list)
 * ------------------------------------------------------------------ */

export function parsePythonLiteral(input) {
  let index = 0;
  const skip = () => {
    while (index < input.length && /\s/.test(input[index])) index += 1;
  };
  const parseString = () => {
    const quote = input[index];
    index += 1;
    let result = '';
    while (index < input.length) {
      const char = input[index];
      index += 1;
      if (char === quote) return result;
      if (char !== '\\') {
        result += char;
        continue;
      }
      const escaped = input[index];
      index += 1;
      const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', "'": "'", '"': '"' };
      result += Object.prototype.hasOwnProperty.call(escapes, escaped) ? escapes[escaped] : escaped;
    }
    throw new SyntaxError('unterminated string literal');
  };
  const parseList = () => {
    index += 1;
    const result = [];
    skip();
    if (input[index] === ']') {
      index += 1;
      return result;
    }
    for (;;) {
      result.push(parseValue());
      skip();
      if (input[index] === ',') {
        index += 1;
        skip();
        if (input[index] === ']') {
          index += 1;
          return result;
        }
        continue;
      }
      if (input[index] === ']') {
        index += 1;
        return result;
      }
      throw new SyntaxError(`expected ',' or ']' at ${index}`);
    }
  };
  const parseObject = () => {
    index += 1;
    const result = {};
    skip();
    if (input[index] === '}') {
      index += 1;
      return result;
    }
    for (;;) {
      skip();
      const key = parseString();
      skip();
      if (input[index] !== ':') throw new SyntaxError(`expected ':' at ${index}`);
      index += 1;
      result[key] = parseValue();
      skip();
      if (input[index] === ',') {
        index += 1;
        skip();
        if (input[index] === '}') {
          index += 1;
          return result;
        }
        continue;
      }
      if (input[index] === '}') {
        index += 1;
        return result;
      }
      throw new SyntaxError(`expected ',' or '}' at ${index}`);
    }
  };
  const parseValue = () => {
    skip();
    const char = input[index];
    if (char === '[') return parseList();
    if (char === '{') return parseObject();
    if (char === "'" || char === '"') return parseString();
    if (input.startsWith('None', index)) {
      index += 4;
      return null;
    }
    if (input.startsWith('True', index)) {
      index += 4;
      return true;
    }
    if (input.startsWith('False', index)) {
      index += 5;
      return false;
    }
    const number = /^-?\d+(?:\.\d+)?/.exec(input.slice(index));
    if (number) {
      index += number[0].length;
      return Number(number[0]);
    }
    throw new SyntaxError(`unexpected token at ${index}`);
  };

  const value = parseValue();
  skip();
  if (index !== input.length) throw new SyntaxError(`trailing content at ${index}`);
  return value;
}

function pyString(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `'${escaped}'`;
}

export function pyLiteral(value) {
  if (value === null || value === undefined || value === '') return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (Array.isArray(value)) return `[${value.map((item) => pyLiteral(item)).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => `${pyString(key)}: ${pyLiteral(item)}`);
    return `{${entries.join(', ')}}`;
  }
  return pyString(value);
}

/* ------------------------------------------------------------------ *
 * CSV in / out
 * ------------------------------------------------------------------ */

export function parseCsv(textValue) {
  const input = String(textValue ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((value) => value.trim() !== '')) rows.push(row);
  }
  if (!rows.length) return [];

  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function csvCell(value) {
  const stringified = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(stringified) ? `"${stringified.replace(/"/g, '""')}"` : stringified;
}

/** Serializes the exact seed CSV layout: UTF-8 BOM, CRLF, `sourses` server rows. */
export function toSeedCsv(channels) {
  const lines = [CSV_HEADER.join(',')];
  for (const channel of channels) {
    const sources = channel.sources
      .slice()
      .sort((a, b) => Number(a.vip) - Number(b.vip) || (a.id ?? 0) - (b.id ?? 0))
      .map((source) => ({
        ID: source.id,
        title: source.title,
        channel_url: source.url,
        channel_referer: source.referer,
        channel_origin: source.origin,
        country: source.country,
        isvip: source.vip ? 1 : 0,
        channel_headers: null,
      }));

    const row = [
      channel.id,
      channel.categoryId,
      channel.name,
      channel.nameEn,
      channel.image ?? '',
      channel.url,
      channel.referer ?? '',
      '',
      channel.origin ?? '',
      channel.vpn ? 1 : 0,
      channel.iran ? 1 : 0,
      channel.popular,
      channel.vip ? 1 : 0,
      channel.category ?? '',
      channel.categoryEn ?? '',
      '',
      pyLiteral(sources),
    ];
    lines.push(row.map(csvCell).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/* ------------------------------------------------------------------ *
 * JSON document
 * ------------------------------------------------------------------ */

export function channelsFromJsonDocument(payload, sourceId = 'existing') {
  const rows = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray(payload.channels)
      ? payload.channels
      : payload && typeof payload === 'object' && Array.isArray(payload.posts)
        ? payload.posts
        : [];
  return makeChannels(rows, sourceId);
}

function channelToJson(channel) {
  return {
    channel_id: channel.id,
    category_id: channel.categoryId,
    channel_name: channel.name,
    channel_name_en: channel.nameEn,
    channel_image: channel.image,
    channel_url: channel.url,
    channel_referer: channel.referer,
    channel_origin: channel.origin,
    need_vpn: channel.vpn ? 1 : 0,
    for_iran: channel.iran ? 1 : 0,
    popular: channel.popular,
    isvip: channel.vip ? 1 : 0,
    category_name: channel.category,
    category_name_en: channel.categoryEn,
    country: channel.country,
    language: channel.language,
    sources: channel.sources.map((source) => ({
      ID: source.id,
      title: source.title,
      channel_url: source.url,
      channel_referer: source.referer,
      channel_origin: source.origin,
      country: source.country,
      isvip: source.vip ? 1 : 0,
    })),
  };
}

/** True when two catalog documents only differ by their generation timestamp. */
export function sameCatalogContent(a, b) {
  if (!a || !b) return false;
  const strip = (document) => {
    const clone = { ...document };
    delete clone.generatedAt;
    delete clone.stats;
    return JSON.stringify(clone);
  };
  return strip(a) === strip(b);
}

export function toJsonDocument(channels, meta = {}) {
  return {
    version: 1,
    generator: 'tv-scrap/scrape-channels',
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    count: channels.length,
    channels: channels.map(channelToJson),
  };
}

/* ------------------------------------------------------------------ *
 * Merge / de-duplicate / stable IDs
 * ------------------------------------------------------------------ */

function nameTokens(value) {
  return new Set(
    String(value ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^0-9a-z\u0600-\u06ff]+/g, ' ')
      .split(' ')
      .filter((token) => token.length > 1),
  );
}

const GENERIC_NAME_TOKENS = new Set([
  'tv', 'live', 'stream', 'streaming', 'channel', 'hd', 'fhd', 'uhd', '4k', 'online', 'official',
  'پخش', 'زنده', 'شبکه', 'کانال', 'تلویزیون', 'اینترنتی',
]);

/** Name tokens with player/marketing noise removed ("4U Family Live Stream" → {4u, family}). */
function significantTokens(value) {
  const tokens = nameTokens(value);
  const filtered = new Set([...tokens].filter((token) => !GENERIC_NAME_TOKENS.has(token)));
  return filtered.size ? filtered : tokens;
}

/** One token set contains the other, e.g. {4u,family} ⊂ {4u,family,live,stream}. */
function relatedNames(a, b) {
  const left = significantTokens(a);
  const right = significantTokens(b);
  if (!left.size || !right.size) return false;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const token of small) if (!large.has(token)) return false;
  return true;
}

function sameTokenSet(a, b) {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (!left.size || left.size !== right.size) return false;
  for (const token of left) if (!right.has(token)) return false;
  return true;
}

function compareChannels(a, b) {
  return (
    b.popular - a.popular ||
    nameKey(a.nameEn).localeCompare(nameKey(b.nameEn)) ||
    urlKey(a.url).localeCompare(urlKey(b.url))
  );
}

function allocate(preferred, key, range, used) {
  if (Number.isInteger(preferred) && preferred > 0 && !used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }
  const span = range.max - range.min + 1;
  let id = range.min + (sha1Int(key) % span);
  let guard = 0;
  while (used.has(id) && guard < span) {
    id = range.min + ((id - range.min + 1) % span);
    guard += 1;
  }
  used.add(id);
  return id;
}

function mergeChannel(target, incoming) {
  const seen = new Set([urlKey(target.url), ...target.sources.map((source) => urlKey(source.url))]);
  // The freshly scraped primary URL becomes an extra backup server of the
  // already published channel, so a new mirror never replaces a known-good one.
  const candidates = [
    {
      id: null,
      title: `Server (${incoming.scrapedFrom[0] ?? 'scraped'})`,
      url: incoming.url,
      referer: incoming.referer,
      origin: incoming.origin,
      country: incoming.country,
      vip: incoming.vip,
    },
    ...incoming.sources,
  ];
  for (const source of candidates) {
    const key = urlKey(source.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    target.sources.push({ ...source });
  }
  target.image = target.image || incoming.image;
  target.referer = target.referer || incoming.referer;
  target.origin = target.origin || incoming.origin;
  target.country = target.country || incoming.country;
  target.language = target.language || incoming.language;
  target.popular = Math.max(target.popular, incoming.popular);
  target.vpn = target.vpn || incoming.vpn;
  target.iran = target.iran || incoming.iran;
  target.vip = target.vip || incoming.vip;
  const GENERIC_CATEGORIES = new Set(['', ...['Persian TV', 'Uncategorized', 'بدون دسته‌بندی', 'General'].map(nameKey)]);
  if (incoming.categoryEn && GENERIC_CATEGORIES.has(nameKey(target.categoryEn)) && !GENERIC_CATEGORIES.has(nameKey(incoming.categoryEn))) {
    // A scraped page can classify a channel better than the "Persian TV" default.
    target.categoryEn = incoming.categoryEn;
    target.category = incoming.category || incoming.categoryEn;
    target.categoryId = 0;
  }
  if (!target.categoryEn && incoming.categoryEn) {
    target.categoryEn = incoming.categoryEn;
    target.category = target.category || incoming.category;
  }
  if (!target.category) target.category = incoming.category;
  if (!target.nameEn && incoming.nameEn) target.nameEn = incoming.nameEn;
  // "“4U Family” Live Stream" + "4U Family" → keep the clean, shorter label.
  if (incoming.name && incoming.name.length < target.name.length && relatedNames(target.name, incoming.name)) {
    target.name = incoming.name;
  }
  if (incoming.nameEn && incoming.nameEn.length < target.nameEn.length && relatedNames(target.nameEn, incoming.nameEn)) {
    target.nameEn = incoming.nameEn;
  }
  for (const origin of incoming.scrapedFrom) {
    if (!target.scrapedFrom.includes(origin)) target.scrapedFrom.push(origin);
  }
}

/**
 * Collapses stale twins that survived from earlier runs: same primary stream and
 * a related name, but two different channel ids (which the id guard in
 * findMatch keeps apart). The older (smaller) id wins and the cleaner name is
 * adopted, so re-running the scraper heals previous noisy output.
 */
function dedupeChannels(channels) {
  const ordered = channels.slice().sort((a, b) => (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER));
  const result = [];
  const byUrl = new Map();

  for (const channel of ordered) {
    const key = urlKey(channel.url);
    const bucket = key ? byUrl.get(key) ?? [] : [];
    const twin = bucket.find(
      (candidate) =>
        nameKey(candidate.nameEn) === nameKey(channel.nameEn) ||
        nameKey(candidate.name) === nameKey(channel.name) ||
        relatedNames(candidate.nameEn, channel.nameEn) ||
        relatedNames(candidate.name, channel.name),
    );
    if (twin) {
      mergeChannel(twin, channel);
      continue;
    }
    result.push(channel);
    if (key) {
      if (!byUrl.has(key)) byUrl.set(key, []);
      byUrl.get(key).push(channel);
    }
  }

  return result;
}

/**
 * Merges previously published output, baseline catalog(s) and fresh scrape
 * results into one de-duplicated catalog, then assigns stable numeric IDs.
 *
 * Priority: `existing` (already published IDs) → `baseline` → `scraped`.
 */
export function buildCatalog(input = {}) {
  const { existing = [], baseline = [], scraped = [], categoryIds = {} } = input;
  const channels = [];
  const byName = new Map();
  const byUrl = new Map();
  const stats = { existing: existing.length, baseline: baseline.length, scraped: scraped.length, added: 0, merged: 0 };

  const idCompatible = (a, b) => !(a.id && b.id && a.id !== b.id);

  const indexChannel = (channel) => {
    for (const key of [nameKey(channel.nameEn), nameKey(channel.name)]) {
      if (!key) continue;
      const bucket = byName.get(key);
      if (!bucket) byName.set(key, [channel]);
      else if (!bucket.includes(channel)) bucket.push(channel);
    }
    for (const key of [urlKey(channel.url), ...channel.sources.map((source) => urlKey(source.url))]) {
      if (!key) continue;
      const bucket = byUrl.get(key);
      if (!bucket) byUrl.set(key, [channel]);
      else if (!bucket.includes(channel)) bucket.push(channel);
    }
  };

  const findMatch = (incoming) => {
    for (const key of [nameKey(incoming.nameEn), nameKey(incoming.name)]) {
      const bucket = key ? byName.get(key) : null;
      const hit = bucket?.find((candidate) => idCompatible(candidate, incoming));
      if (hit) return hit;
    }
    // A shared stream URL is only proof of identity when the names also agree
    // on their meaningful tokens — otherwise distinct channels that happen to
    // reuse one mirror would collapse into a single row.
    for (const key of [urlKey(incoming.url), ...incoming.sources.map((source) => urlKey(source.url))]) {
      const bucket = key ? byUrl.get(key) : null;
      if (!bucket) continue;
      const hit = bucket.find(
        (candidate) =>
          idCompatible(candidate, incoming) &&
          (nameKey(candidate.nameEn) === nameKey(incoming.nameEn) ||
            nameKey(candidate.name) === nameKey(incoming.name) ||
            sameTokenSet(candidate.nameEn, incoming.nameEn) ||
            sameTokenSet(candidate.name, incoming.name) ||
            relatedNames(candidate.nameEn, incoming.nameEn) ||
            relatedNames(candidate.name, incoming.name)),
      );
      if (hit) return hit;
    }
    return null;
  };

  const absorb = (incoming) => {
    const match = findMatch(incoming);
    if (!match) {
      channels.push(incoming);
      indexChannel(incoming);
      if (stats.existing || stats.baseline || stats.scraped) stats.added += 1;
      return;
    }
    mergeChannel(match, incoming);
    indexChannel(match);
    stats.merged += 1;
  };

  for (const channel of existing) absorb(channel);
  for (const channel of baseline) absorb(channel);
  for (const channel of scraped) absorb(channel);

  const beforeDedupe = channels.length;
  const deduped = dedupeChannels(channels);
  channels.length = 0;
  channels.push(...deduped);
  stats.duplicatesCollapsed = beforeDedupe - channels.length;

  // Stable ordering keeps IDs identical between runs.
  channels.sort(compareChannels);

  const usedChannelIds = new Set();
  const usedSourceIds = new Set();
  const usedCategoryIds = new Set();
  const categoryMap = new Map();
  const categoryByName = new Map();

  const overrideFor = (key) => {
    for (const [name, id] of Object.entries(categoryIds ?? {})) {
      if (nameKey(name) === key && Number.isInteger(Number(id))) return Number(id);
    }
    return null;
  };

  const registerCategory = (entry) => {
    if (!entry || !Number.isInteger(entry.id) || entry.id < 0) return null;
    const existing = categoryMap.get(entry.id);
    if (existing) return existing;
    const record = {
      id: entry.id,
      name: entry.name || entry.nameEn || 'Persian TV',
      nameEn: entry.nameEn || entry.name || 'Persian TV',
    };
    categoryMap.set(record.id, record);
    usedCategoryIds.add(record.id);
    const key = nameKey(record.nameEn);
    if (key && !categoryByName.has(key)) categoryByName.set(key, record.id);
    return record;
  };

  // Keep the category rows that already exist (ids 1..26 plus the id-0 fallback)
  // so foreign keys in the published database never move.
  for (const channel of channels) {
    if (channel.categoryId > 0) {
      registerCategory({ id: channel.categoryId, name: channel.category, nameEn: channel.categoryEn });
    }
  }
  const UNCATEGORIZED = new Set(['', nameKey('Uncategorized'), nameKey('بدون دسته‌بندی'), nameKey('Uncategorized TV')]);
  const uncategorized = channels.find((channel) => !channel.categoryId && UNCATEGORIZED.has(nameKey(channel.categoryEn || channel.category)));
  if (uncategorized) {
    registerCategory({
      id: 0,
      name: text(uncategorized.category) || 'بدون دسته‌بندی',
      nameEn: text(uncategorized.categoryEn) || 'Uncategorized',
    });
  }

  for (const channel of channels) {
    if (channel.categoryId > 0) continue;

    const nameEn = text(channel.categoryEn || channel.category);
    if (!nameEn) {
      channel.categoryId = 0;
      channel.category = 'بدون دسته‌بندی';
      channel.categoryEn = 'Uncategorized';
      continue;
    }

    const key = nameKey(nameEn);
    let id = categoryByName.get(key);
    if (id === undefined) {
      id = overrideFor(key) ?? allocate(null, `category:${key}`, ID_RANGES.category, usedCategoryIds);
      registerCategory({ id, name: channel.category || nameEn, nameEn });
    }
    channel.categoryId = id;
    channel.category = categoryMap.get(id)?.name ?? channel.category;
    channel.categoryEn = categoryMap.get(id)?.nameEn ?? channel.categoryEn;
  }

  for (const channel of channels) {
    channel.id = allocate(channel.id, `channel:${nameKey(channel.nameEn)}:${urlKey(channel.url)}`, ID_RANGES.channel, usedChannelIds);

    const seenSourceUrls = new Set();
    const keptSources = [];
    for (const source of channel.sources) {
      const key = urlKey(source.url);
      if (!key || seenSourceUrls.has(key)) continue;
      seenSourceUrls.add(key);
      source.id = allocate(source.id, `source:${key}`, ID_RANGES.source, usedSourceIds);
      keptSources.push(source);
    }
    channel.sources = keptSources;
  }

  const categories = [...categoryMap.values()].sort((a, b) => a.id - b.id);
  return { channels, categories, stats };
}

/* ------------------------------------------------------------------ *
 * Validation / summary
 * ------------------------------------------------------------------ */

export function validateCatalog(document) {
  const errors = [];
  const warnings = [];
  const rows = Array.isArray(document) ? document : document?.channels;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, errors: ['catalog contains no channels'], warnings };
  }

  const channelIds = new Set();
  const sourceIds = new Map();
  const categoryIds = new Map();
  let sourceCount = 0;

  rows.forEach((row, index) => {
    const label = row?.channel_name_en || row?.channel_name || `#${index}`;

    if (!Number.isInteger(row?.channel_id) || row.channel_id <= 0) errors.push(`${label}: invalid channel_id`);
    else if (channelIds.has(row.channel_id)) errors.push(`${label}: duplicate channel_id ${row.channel_id}`);
    else channelIds.add(row.channel_id);

    if (!text(row?.channel_name)) errors.push(`${label}: missing channel_name`);
    if (!isHttpUrl(row?.channel_url)) errors.push(`${label}: invalid channel_url`);

    if (!Number.isInteger(row?.category_id) || row.category_id < 0) {
      errors.push(`${label}: invalid category_id`);
    } else if (row.category_id > 0) {
      const key = nameKey(row.category_name_en || row.category_name);
      const known = categoryIds.get(key);
      if (known && known !== row.category_id) {
        warnings.push(`${label}: category "${row.category_name_en}" is shared by ids ${known} and ${row.category_id}`);
      } else {
        categoryIds.set(key, row.category_id);
      }
    }

    const urls = new Set();
    for (const source of Array.isArray(row?.sources) ? row.sources : []) {
      sourceCount += 1;
      const sourceUrl = source?.channel_url ?? source?.url;
      if (!isHttpUrl(sourceUrl)) {
        errors.push(`${label}: invalid source url`);
        continue;
      }
      const key = urlKey(sourceUrl);
      if (urls.has(key)) warnings.push(`${label}: duplicate source url ${sourceUrl}`);
      urls.add(key);

      if (!Number.isInteger(source?.ID) || source.ID <= 0) {
        errors.push(`${label}: invalid source ID`);
      } else if (sourceIds.has(source.ID) && sourceIds.get(source.ID) !== key) {
        errors.push(`${label}: source ID ${source.ID} reused for two different urls`);
      } else {
        sourceIds.set(source.ID, key);
      }
    }
  });

  return { ok: errors.length === 0, errors, warnings, stats: { channels: rows.length, sources: sourceCount, categories: categoryIds.size } };
}

export function catalogSummary(channels) {
  const byCategory = new Map();
  let sources = 0;
  let withSources = 0;
  for (const channel of channels) {
    sources += channel.sources.length;
    if (channel.sources.length) withSources += 1;
    const key = channel.categoryEn || channel.category || 'Persian TV';
    byCategory.set(key, (byCategory.get(key) ?? 0) + 1);
  }
  return {
    channels: channels.length,
    sources,
    withSources,
    categories: byCategory.size,
    byCategory: Object.fromEntries([...byCategory.entries()].sort((a, b) => b[1] - a[1])),
  };
}
