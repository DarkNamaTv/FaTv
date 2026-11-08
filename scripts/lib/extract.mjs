
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  zwnj: '\u200c',
};

export function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeChar(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

export function stripTags(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const NAME_NOISE = [
  /\s*[|•»–—:]\s*$/,
  /^(?:watch|live\s*stream|stream|پخش\s*زنده)\s*[:|-]\s*/i,
  /\s*[-–—|]\s*(?:live\s*stream(?:ing)?|live\s*tv|live|پخش\s*زنده|آنلاین|online|stream(?:ing)?)$/i,
  /\s*\(?(?:live\s*stream|live\s*tv|live|پخش\s*زنده|full\s*hd|fhd|uhd|hd|sd|4k)\)?$/i,
];

/**
 * Turns scraped page/embed titles into a channel name:
 * `“4U Family” Live Stream` → `4U Family`.
 */
export function cleanChannelName(value) {
  let name = stripTags(value)
    .replace(/^[\s"“”'«»\[\]()]+/, '')
    .replace(/[\s"“”'«»\[\]()]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  for (let pass = 0; pass < 4; pass += 1) {
    const before = name;
    for (const pattern of NAME_NOISE) name = name.replace(pattern, '').trim();
    name = name.replace(/^[\s"“”'«»\-–—|:]+/, '').replace(/[\s"“”'«»\-–—|:]+$/, '').trim();
    if (name === before || !name) break;
  }

  return name.length >= 2 ? name : stripTags(value).trim();
}

const GENERIC_PATH_TOKENS = /^(stream|master|index|playlist|live|hls|mono|chunklist|video|watch|embed|manifest|prog_index|tracks|playout)$/i;

/** Last-resort readable name derived from the stream path. */
export function guessNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));

    if (segments.length && /\.(m3u8|mpd)$/i.test(segments[segments.length - 1])) segments.pop();

    const tokens = segments.slice().reverse();
    const candidate =
      tokens.find((segment) => !GENERIC_PATH_TOKENS.test(segment.replace(/\.[a-z0-9]+$/i, ''))) || parsed.hostname.replace(/^www\./, '');

    return candidate
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/=/g, ' ')
      .trim()
      .replace(/\s{2,}/g, ' ');
  } catch {
    return '';
  }
}
