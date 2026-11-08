#!/usr/bin/env node
/**
 * Validates a published catalog file without touching the network.
 *
 *   node scripts/validate-catalog.mjs [data/channels.json]
 */
import fs from 'node:fs/promises';
import process from 'node:process';

import { catalogSummary, channelsFromJsonDocument, validateCatalog } from './lib/catalog.mjs';
import { log } from './lib/util.mjs';

const filePath = process.argv[2] ?? 'data/channels.json';
const allowEmpty = process.argv.includes('--allow-empty');

async function main() {
  const raw = await fs.readFile(filePath, 'utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    log.error(`${filePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    process.exitCode = 1;
    return;
  }

  const channels = channelsFromJsonDocument(payload, 'validation');
  const validation = validateCatalog(payload);
  const summary = catalogSummary(channels);

  log.info(`${filePath}`);
  log.info(`  channels: ${summary.channels}, sources: ${summary.sources}, categories: ${summary.categories}`);

  if (summary.channels === 0) {
    if (allowEmpty) {
      log.warn('catalog is empty (allowed with --allow-empty)');
      return;
    }
    log.error('catalog is empty');
    process.exitCode = 1;
    return;
  }

  for (const warning of validation.warnings.slice(0, 20)) log.warn(warning);

  if (!validation.ok) {
    for (const error of validation.errors.slice(0, 50)) log.error(error);
    log.error(`${validation.errors.length} problem(s) found.`);
    process.exitCode = 1;
    return;
  }

  log.ok('catalog is valid');
}

main().catch((error) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
