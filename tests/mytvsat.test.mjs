import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { normalizeMytvsatPosts, tryAes256CbcJson } from '../scripts/lib/sources.mjs';

const SOURCE = { id: 'mytvsat', category: 'Persian TV', categoryEn: 'Persian TV' };
const CTX = { categoryRules: [] };

function fixturePosts() {
  return {
    posts: [
      {
        channel_id: 103, category_id: 18, channel_name: 'رادیو جوان', channel_name_en: 'Radio Javan',
        channel_image: 'https://x.test/rj.png', channel_url: 'https://rjtvhls.wns.live/hls/stream.m3u8',
        channel_referer: 'https://x.test/', channel_origin: 'https://x.test', need_vpn: 0, for_iran: 1,
        popular: 42, isvip: 0, category_name: 'موزیک', category_name_en: 'Music',
        sourses: [{ ID: 7, title: 'Server 2', channel_url: 'https://x.test/rj2.m3u8' }],
      },
      {
        channel_id: 104, category_id: 0, channel_name_en: 'Mystery', channel_url: 'https://x.test/m.m3u8',
        category_name_en: '?',
      },
      { channel_name_en: 'NoUrl' }, // dropped: no stream url
    ],
  };
}

test('normalizeMytvsatPosts maps upstream rows and drops private ids', () => {
  const channels = normalizeMytvsatPosts(fixturePosts(), SOURCE, CTX);
  assert.equal(channels.length, 2);
  const [rj, mystery] = channels;
  assert.equal(rj.nameEn, 'Radio Javan');
  assert.equal(rj.name, 'رادیو جوان');
  assert.equal(rj.id, null);
  assert.equal(rj.categoryId, 0);
  assert.equal(rj.categoryEn, 'Music');
  assert.equal(rj.image, 'https://x.test/rj.png');
  assert.equal(rj.popular, 42);
  assert.equal(rj.iran, true);
  assert.equal(rj.sources.length, 1);
  assert.equal(rj.sources[0].url, 'https://x.test/rj2.m3u8');
  assert.equal(rj.sources[0].id, null);
  assert.equal(mystery.categoryEn, 'Persian TV'); // '?' falls back to the source default
});

test('normalizeMytvsatPosts rejects payloads without posts', () => {
  assert.throws(() => normalizeMytvsatPosts({}, SOURCE, CTX), /no posts array/);
  assert.throws(() => normalizeMytvsatPosts(null, SOURCE, CTX), /no posts array/);
});

test('mytvsat decrypt+normalize chain round-trips offline', () => {
  const key = randomBytes(32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const payload = gzipSync(JSON.stringify(fixturePosts()));
  const b64 = Buffer.concat([cipher.update(payload), cipher.final()]).toString('base64');
  const json = tryAes256CbcJson(b64, key, iv);
  const channels = normalizeMytvsatPosts(json, SOURCE, CTX);
  assert.equal(channels.length, 2);
  assert.equal(channels[0].nameEn, 'Radio Javan');
});

test('normalizeMytvsatPosts resolves relative images against imageBase', () => {
  const withBase = { ...SOURCE, imageBase: 'https://cdn.test/logos/' };
  const [relative] = normalizeMytvsatPosts({ posts: [{ channel_name_en: 'X', channel_url: 'https://x.test/x.m3u8', channel_image: '1782140219534.jpg' }] }, withBase, CTX);
  assert.equal(relative.image, 'https://cdn.test/logos/1782140219534.jpg');
  const [absolute] = normalizeMytvsatPosts({ posts: [{ channel_name_en: 'Y', channel_url: 'https://x.test/y.m3u8', channel_image: 'https://other.test/a.png' }] }, withBase, CTX);
  assert.equal(absolute.image, 'https://other.test/a.png');
});

test('mytvsat adapter reads the encrypted feed from a local mirror file', async () => {
  const { createCipheriv, randomBytes } = await import('node:crypto');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { runSource } = await import('../scripts/lib/sources.mjs');
  const key = randomBytes(32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const doc = { posts: [{ channel_name_en: 'Local', channel_url: 'https://x.test/l.m3u8', channel_image: 'l.png', category_name_en: 'News', category_name: 'اخبار' }] };
  const enc = Buffer.concat([cipher.update(JSON.stringify(doc), 'utf8'), cipher.final()]).toString('base64');
  const dir = mkdtempSync(join(tmpdir(), 'mytvsat-'));
  writeFileSync(join(dir, 'posts'), enc);
  process.env.MYTVSAT_TEST_KEY_HEX = key.toString('hex');
  process.env.MYTVSAT_TEST_IV_HEX = iv.toString('hex');
  try {
    const result = await runSource({ id: 't', kind: 'encrypted-json', url: join(dir, 'posts'), keyEnv: 'MYTVSAT_TEST_KEY_HEX', ivEnv: 'MYTVSAT_TEST_IV_HEX', imageBase: 'https://cdn.test/logos/' }, { categoryRules: [] });
    assert.equal(result.channels.length, 1);
    assert.equal(result.channels[0].nameEn, 'Local');
    assert.equal(result.channels[0].image, 'https://cdn.test/logos/l.png');
  } finally {
    delete process.env.MYTVSAT_TEST_KEY_HEX;
    delete process.env.MYTVSAT_TEST_IV_HEX;
    rmSync(dir, { recursive: true, force: true });
  }
});
