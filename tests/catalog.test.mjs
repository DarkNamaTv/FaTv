import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCatalog,
  channelsFromJsonDocument,
  makeChannel,
  parseCsv,
  parsePythonLiteral,
  pyLiteral,
  sameCatalogContent,
  toJsonDocument,
  toSeedCsv,
  validateCatalog,
  CSV_HEADER,
} from '../scripts/lib/catalog.mjs';

const baseline = () =>
  makeChannel(
    {
      channel_id: 71,
      category_id: 20,
      channel_name: 'جم تیوی',
      channel_name_en: 'Gem TV',
      channel_image: '1782140219562.png',
      channel_url: 'https://gemtv.ardanmi.com/live/ADrg3rKMyZn7gfgEQMSEOw__/master.m3u8',
      channel_referer: 'https://salmal1000.com/',
      channel_origin: 'https://salmal1000.com',
      need_vpn: 0,
      for_iran: 1,
      isvip: 0,
      popular: 49481005,
      category_name: 'شبکه های جم',
      category_name_en: 'GEM TV Networks',
      sourses: [
        {
          ID: 734,
          title: 'سرورخارج',
          channel_url: 'https://gg.hls2.xyz/live/IR%20-%20GEM%20TV2/playlist.m3u8',
          channel_referer: 'https://www.aparatchii.com/',
          channel_origin: 'https://www.aparatchii.com',
          country: 'worldwide',
          isvip: 0,
          channel_headers: null,
        },
        {
          ID: 54,
          title: 'سرورمناسب ایران۱',
          channel_url: 'https://cp12.adabmedia.com/hls/live4/stream.m3u8',
          channel_referer: 'https://mytvsat.tv',
          channel_origin: '',
          country: 'iran',
          isvip: 0,
          channel_headers: null,
        },
      ],
    },
    'seed',
  );

test('makeChannel normalizes snake_case rows and dedupes sources', () => {
  const channel = baseline();
  assert.equal(channel.id, 71);
  assert.equal(channel.categoryId, 20);
  assert.equal(channel.nameEn, 'Gem TV');
  assert.equal(channel.iran, true);
  assert.equal(channel.vpn, false);
  assert.equal(channel.popular, 49481005);
  assert.equal(channel.sources.length, 2);
  assert.equal(channel.sources[0].id, 734);
  assert.equal(channel.sources[0].country, 'worldwide');

  // The catalog lists the primary stream again as a "server" row, with its own ID:
  // those rows are kept (the DB has one Source row per ID) but true duplicates
  // inside the source list are collapsed.
  const withDuplicate = makeChannel({
    name: 'Duplicate',
    nameEn: 'Duplicate',
    url: 'https://a.test/x.m3u8',
    sources: [
      { id: 1, url: 'https://a.test/x.m3u8' },
      { id: 2, url: 'https://a.test/x.m3u8' },
      { id: 3, url: 'https://b.test/y.m3u8' },
    ],
  });
  assert.equal(withDuplicate.sources.length, 2);
  assert.deepEqual(withDuplicate.sources.map((source) => source.id), [1, 3]);
});

test('buildCatalog keeps baseline IDs and merges freshly scraped duplicates', () => {
  const scraped = makeChannel(
    {
      name: 'جم تی وی',
      nameEn: 'Gem TV',
      url: 'https://new-mirror.test/gem-tv/master.m3u8',
      referer: 'https://x.test/channel/gem-tv',
      category: 'Persian TV',
      categoryEn: 'Persian TV',
      sources: [{ title: 'Server 2', url: 'https://gg.hls2.xyz/live/IR%20-%20GEM%20TV2/playlist.m3u8' }],
    },
    'feed',
  );

  const { channels, stats } = buildCatalog({ baseline: [baseline()], scraped: [scraped] });

  assert.equal(channels.length, 1, 'same channel name collapses into one row');
  assert.equal(channels[0].id, 71, 'baseline channel_id is preserved');
  assert.equal(channels[0].categoryId, 20, 'baseline category is preserved');
  assert.equal(channels[0].sources.length, 3, 'new mirror added, duplicate source not repeated');
  assert.ok(channels[0].sources.some((source) => source.url.includes('new-mirror.test')));
  assert.ok(channels[0].scrapedFrom.includes('seed'));
  assert.ok(channels[0].scrapedFrom.includes('feed'));
  assert.equal(stats.merged, 1);
});

test('buildCatalog assigns stable, collision-free IDs on every run', () => {
  const rows = [
    { name: 'Alpha', nameEn: 'Alpha TV', url: 'https://a.test/alpha.m3u8', category: 'Persian TV', categoryEn: 'Persian TV' },
    { name: 'Beta', nameEn: 'Beta TV', url: 'https://b.test/beta.m3u8', category: 'Persian TV', categoryEn: 'Persian TV' },
    { name: 'Gamma', nameEn: 'Gamma', url: 'https://c.test/gamma.m3u8', category: 'News', categoryEn: 'News' },
  ].map((row) => makeChannel(row, 'scraped'));

  const first = buildCatalog({ scraped: rows });
  const second = buildCatalog({ scraped: rows.map((row) => ({ ...row })) });

  const ids = (catalog) => catalog.channels.map((channel) => channel.id).sort((a, b) => a - b);
  assert.deepEqual(ids(first), ids(second), 'IDs are deterministic');
  assert.equal(new Set(ids(first)).size, 3, 'IDs are unique');
  assert.ok(ids(first).every((id) => id >= 10_000), 'new channels use the reserved range');

  const categories = first.channels.map((channel) => channel.categoryId);
  assert.equal(new Set(categories).size, 2, 'category names map to stable category ids');

  const sourceIds = first.channels.flatMap((channel) => channel.sources.map((source) => source.id)).filter(Boolean);
  assert.equal(new Set(sourceIds).size, sourceIds.length, 'source IDs never collide across channels');
});

test('seed CSV writer matches the seed schema', () => {
  const { channels } = buildCatalog({ baseline: [baseline()] });
  const csv = toSeedCsv(channels);

  assert.ok(csv.startsWith('\uFEFF'), 'UTF-8 BOM like the original file');
  assert.ok(csv.includes('\r\n'), 'CRLF line endings like the original file');
  assert.equal(csv.split('\r\n')[0].replace('\uFEFF', ''), CSV_HEADER.join(','));

  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel_id, '71');
  assert.equal(rows[0].channel_name, 'جم تیوی');
  assert.match(rows[0].sourses, /^\[\{'ID': 54, 'title': 'سرورمناسب ایران۱'/);
  assert.match(rows[0].sourses, /\{'ID': 734, 'title': 'سرورخارج'/);

});

test('python literals handle quotes, backslashes and None', () => {
  const value = [{ ID: 1, title: "Server's \"best\"\nline", channel_headers: null, isvip: 0 }];
  const literal = pyLiteral(value);
  assert.equal(literal, "[{'ID': 1, 'title': 'Server\\'s \"best\"\\nline', 'channel_headers': None, 'isvip': 0}]");
  assert.deepEqual(parsePythonLiteral(literal), value);
});

test('JSON document keeps the published catalog shape', () => {
  const { channels } = buildCatalog({ baseline: [baseline()] });
  const document = toJsonDocument(channels, { generatedAt: '2026-01-01T00:00:00.000Z' });

  assert.equal(document.version, 1);
  assert.equal(document.count, 1);
  assert.equal(document.generatedAt, '2026-01-01T00:00:00.000Z');

  const [row] = document.channels;
  assert.equal(row.channel_id, 71);
  assert.equal(row.channel_name_en, 'Gem TV');
  assert.equal(row.category_name_en, 'GEM TV Networks');
  assert.equal(row.need_vpn, 0);
  assert.equal(row.for_iran, 1);
  assert.equal(row.sources[0].ID, 734);
  assert.equal(row.sources[0].channel_url, channels[0].sources[0].url);

  const back = channelsFromJsonDocument(document, 'existing');
  assert.equal(back.length, 1);
  assert.equal(back[0].id, 71);
  assert.equal(back[0].sources.length, 2);
});

test('a noisy duplicate collapses into the clean name and keeps the existing id', () => {
  const noisy = makeChannel(
    { id: 500, name: '“4U Family” Live Stream', nameEn: '“4U Family” Live Stream', url: 'https://x.test/fam.m3u8' },
    'existing',
  );
  const clean = makeChannel({ name: '4U Family', nameEn: '4U Family', url: 'https://x.test/fam.m3u8' }, 'feed');
  const { channels } = buildCatalog({ existing: [noisy], scraped: [clean] });

  assert.equal(channels.length, 1, 'same stream + related name = one channel');
  assert.equal(channels[0].id, 500);
  assert.equal(channels[0].nameEn, '4U Family');
});

test('stale noisy twins from earlier runs are collapsed, keeping the oldest id', () => {
  const messy = makeChannel(
    { id: 900, name: '“4U Family” Live Stream', nameEn: '“4U Family” Live Stream', url: 'https://x.test/fam.m3u8', category: 'Persian TV', categoryEn: 'Persian TV' },
    'existing',
  );
  const clean = makeChannel(
    { id: 950, name: '4U Family', nameEn: '4U Family', url: 'https://x.test/fam.m3u8', category: 'سرگرمی', categoryEn: 'Entertainment' },
    'existing',
  );

  const { channels } = buildCatalog({ existing: [messy, clean] });

  assert.equal(channels.length, 1, 'two ids for the same stream + related name collapse');
  assert.equal(channels[0].id, 900, 'the older id survives');
  assert.equal(channels[0].nameEn, '4U Family');
  assert.equal(channels[0].categoryEn, 'Entertainment');
});

test('stale twins with unrelated names stay separate even on a shared url', () => {
  const a = makeChannel({ id: 10, name: 'T2 America', nameEn: 'T2 America', url: 'https://x.test/worker.m3u8' }, 'existing');
  const b = makeChannel({ id: 11, name: 'T2 Movies', nameEn: 'T2 Movies', url: 'https://x.test/worker.m3u8' }, 'existing');
  const { channels } = buildCatalog({ existing: [a, b] });
  assert.equal(channels.length, 2);
});

test('different channels sharing a mirror are never merged', () => {
  const news = makeChannel({ id: 1, name: 'Persian News', nameEn: 'Persian News', url: 'https://x.test/shared.m3u8' }, 'existing');
  const sport = makeChannel({ name: 'Persian Sport', nameEn: 'Persian Sport', url: 'https://x.test/shared.m3u8' }, 'feed');
  const { channels } = buildCatalog({ existing: [news], scraped: [sport] });

  assert.equal(channels.length, 2);
  assert.deepEqual(channels.map((channel) => channel.nameEn).sort(), ['Persian News', 'Persian Sport']);
});

test('a generic category is upgraded to the category found by the scraper', () => {
  const existing = makeChannel(
    { id: 7, name: 'BBC Persian', nameEn: 'BBC Persian', url: 'https://x.test/bbc.m3u8', category: 'Persian TV', categoryEn: 'Persian TV' },
    'existing',
  );
  const scraped = makeChannel(
    { name: 'BBC Persian', nameEn: 'BBC Persian', url: 'https://x.test/bbc.m3u8', category: 'اخبار', categoryEn: 'News' },
    'feed',
  );
  const { channels } = buildCatalog({ existing: [existing], scraped: [scraped] });

  assert.equal(channels.length, 1);
  assert.equal(channels[0].categoryEn, 'News');
  assert.notEqual(channels[0].categoryId, 7, 'the new category gets its own id');
});

test('publishing twice is a no-op: no ID drift, no category drift', () => {
  const uncategorized = makeChannel(
    {
      channel_id: 206,
      channel_name: 'رادیو خاطره',
      channel_name_en: 'Khatereh Radio',
      channel_url: 'https://radio.khatereh.online/radio-stream',
      category_id: 0,
      category_name: '',
      category_name_en: '',
    },
    'seed',
  );

  const first = buildCatalog({ baseline: [baseline(), uncategorized] });
  const document = toJsonDocument(first.channels, { generatedAt: '2026-01-01T00:00:00.000Z' });
  const second = buildCatalog({
    existing: channelsFromJsonDocument(document, 'existing'),
    baseline: [baseline(), uncategorized],
  });
  const nextDocument = toJsonDocument(second.channels, { generatedAt: '2026-02-02T00:00:00.000Z' });

  assert.equal(sameCatalogContent(document, nextDocument), true, 'only generatedAt may change');
  assert.equal(document.channels.length, 2);
  const zero = nextDocument.channels.find((channel) => channel.channel_id === 206);
  assert.equal(zero.category_id, 0, 'the id-0 fallback category is preserved');
  assert.equal(zero.category_name_en, 'Uncategorized');
  assert.equal(second.channels.find((channel) => channel.id === 71).id, 71);
});

test('validateCatalog reports duplicate IDs and category conflicts', () => {
  const { channels } = buildCatalog({ baseline: [baseline()] });
  const document = toJsonDocument(channels);
  assert.equal(validateCatalog(document).ok, true);

  const broken = structuredClone(document);
  broken.channels.push({ ...broken.channels[0], channel_name_en: 'Copy' });
  broken.channels[1].category_id = 999;
  const result = validateCatalog(broken);

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('duplicate channel_id')));
  assert.ok(result.warnings.some((warning) => warning.includes('shared by ids')));
});

test('validateCatalog rejects empty and malformed catalogs', () => {
  assert.equal(validateCatalog({ channels: [] }).ok, false);
  const result = validateCatalog({ channels: [{ channel_id: 1, channel_name: 'X', channel_url: 'ftp://nope', category_id: 1 }] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('invalid channel_url')));
});
