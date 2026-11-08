import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanChannelName, guessNameFromUrl } from '../scripts/lib/extract.mjs';

test('guessNameFromUrl produces a readable fallback name', () => {
  assert.equal(guessNameFromUrl('https://cp12.adabmedia.com/hls/funplus/stream.m3u8'), 'funplus');
  assert.equal(guessNameFromUrl('https://a.test/live/gem-tv/master.m3u8'), 'gem tv');
});

test('cleanChannelName strips player noise and wrapping quotes', () => {
  assert.equal(cleanChannelName('“4U Family” Live Stream'), '4U Family');
  assert.equal(cleanChannelName('“AFN Music” Live Stream'), 'AFN Music');
  assert.equal(cleanChannelName('BBC Persian - Live Stream'), 'BBC Persian');
  assert.equal(cleanChannelName('Persian News HD'), 'Persian News');
  assert.equal(cleanChannelName('شبکه سه - پخش زنده'), 'شبکه سه');
  assert.equal(cleanChannelName('Alpha TV'), 'Alpha TV');
  assert.equal(cleanChannelName('  '), '');
});
