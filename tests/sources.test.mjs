import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCategory } from '../scripts/lib/sources.mjs';

const config = JSON.parse(
  await import('node:fs/promises').then((fs) => fs.readFile(new URL('../config/scrape-sources.json', import.meta.url), 'utf8')),
);
const ctx = { categoryRules: config.categoryRules };
const fallback = { category: 'Persian TV', categoryEn: 'Persian TV' };

test('categoryRules classify channels by name and stream url', () => {
  const cases = [
    ['BBC Persian News', 'News'],
    ['Iran International', 'News'],
    ['Voice of America', 'News'],
    ['Radio Javan', 'Music'],
    ['Trace Sports', 'Sports'],
    ['Cartoon Network', 'Kids & Teens'],
    ['National Geographic', 'Documentary'],
    ['Al Quran TV', 'Religious'],
    ['Kabul TV', 'Afghanistan'],
    ['Kurdistan TV', 'Kurdish'],
    ['MBC Persia', 'Arabic'],
    ['شبکه سه', 'Persian TV'],
    ['Gem TV', 'Persian TV'],
  ];

  for (const [name, expected] of cases) {
    assert.equal(resolveCategory(fallback, `${name} https://example.test/${name}`, ctx).categoryEn, expected, name);
  }
});

test('categoryRules fall back to the source default and survive broken patterns', () => {
  assert.equal(resolveCategory({ category: 'شبکه های جم', categoryEn: 'GEM TV Networks' }, 'Gem TV', ctx).categoryEn, 'GEM TV Networks');

  const broken = { categoryRules: [{ pattern: '([unclosed', category: 'X', categoryEn: 'X' }] };
  assert.equal(resolveCategory(fallback, 'anything', broken).categoryEn, 'Persian TV');
  assert.equal(resolveCategory(fallback, 'anything', {}).categoryEn, 'Persian TV');
});
