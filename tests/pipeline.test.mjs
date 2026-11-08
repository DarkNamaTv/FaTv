import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HLS = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:6,\nseg.ts\n';

const TEST_KEY_HEX = crypto.randomBytes(32).toString('hex');
const TEST_IV_HEX = crypto.randomBytes(16).toString('hex');

let server;
let origin;

before(async () => {
  server = http.createServer((request, response) => {
    const url = request.url ?? '/';
    const send = (status, type, body) => {
      response.writeHead(status, { 'content-type': type });
      response.end(body);
    };

    if (url.startsWith('/streams/beta-backup/')) return send(200, 'application/vnd.apple.mpegurl', HLS);
    if (url.startsWith('/streams/beta')) return send(200, 'application/vnd.apple.mpegurl', HLS);
    if (url.startsWith('/streams/alpha')) return send(200, 'application/vnd.apple.mpegurl', HLS);
    return send(404, 'text/plain', 'nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

function encryptFeed(doc) {
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(TEST_KEY_HEX, 'hex'), Buffer.from(TEST_IV_HEX, 'hex'));
  return Buffer.concat([cipher.update(JSON.stringify(doc), 'utf8'), cipher.final()]).toString('base64');
}

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
  const feed = {
    posts: [
      { channel_name_en: 'Alpha TV', channel_url: `${origin}/streams/alpha/master.m3u8`, channel_image: 'alpha.png' },
      {
        channel_name_en: 'Beta TV',
        channel_url: `${origin}/streams/beta/index.m3u8`,
        channel_image: 'beta.png',
        sourses: [{ title: 'backup', channel_url: `${origin}/streams/beta-backup/index.m3u8` }],
      },
      { channel_name_en: 'Broken TV', channel_url: `${origin}/streams/missing/index.m3u8` },
    ],
  };
  const feedPath = path.join(dir, 'feed.enc');
  fs.writeFileSync(feedPath, encryptFeed(feed));
  const config = {
    userAgent: 'test-bot',
    allowPrivateHosts: true,
    respectRobots: true,
    concurrency: 2,
    timeoutMs: 5000,
    retries: 0,
    mergeExisting: false,
    output: { json: path.join(dir, 'channels.json'), csv: path.join(dir, 'seed-data.csv') },
    probe: { enabled: true, scope: 'scraped', concurrency: 2, timeoutMs: 5000 },
    guardrails: { minChannels: 1, maxDropRatio: 0.4 },
    categoryIds: {},
    categoryRules: [],
    sources: [
      {
        id: 'test-feed',
        kind: 'encrypted-json',
        role: 'scraped',
        enabled: true,
        url: feedPath,
        keyEnv: 'PIPE_TEST_KEY_HEX',
        ivEnv: 'PIPE_TEST_IV_HEX',
        category: 'Persian TV',
        categoryEn: 'Persian TV',
        imageBase: `${origin}/img/`,
      },
    ],
  };
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { dir, configPath, config };
}

// The fixture server lives in this process, so the CLI must run without
// blocking the event loop (spawnSync would deadlock the HTTP server).
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/scrape-channels.mjs'), ...args], {
      cwd: ROOT,
      env: { ...process.env, GITHUB_ACTIONS: '', PIPE_TEST_KEY_HEX: TEST_KEY_HEX, PIPE_TEST_IV_HEX: TEST_IV_HEX },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('end-to-end scrape writes a probed, validated catalog', async () => {
  const { dir, configPath, config } = workspace();
  const result = await runCli(['--config', configPath, '--report', path.join(dir, 'report.json')]);

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const document = JSON.parse(fs.readFileSync(config.output.json, 'utf8'));
  assert.equal(document.version, 1);
  assert.equal(document.count, 2, 'channels whose only stream 404s are dropped by the probe');

  const names = document.channels.map((channel) => channel.channel_name_en).sort();
  assert.deepEqual(names, ['Alpha TV', 'Beta TV']);

  const alpha = document.channels.find((channel) => channel.channel_name_en === 'Alpha TV');
  assert.equal(alpha.channel_url, `${origin}/streams/alpha/master.m3u8`);
  assert.equal(alpha.channel_image, `${origin}/img/alpha.png`);
  assert.ok(alpha.channel_id >= 10_000);
  assert.ok(alpha.category_id > 0);
  assert.equal(alpha.category_name_en, 'Persian TV');

  const beta = document.channels.find((channel) => channel.channel_name_en === 'Beta TV');
  assert.ok(beta.sources.length >= 1, 'backup servers are collected');

  const csv = fs.readFileSync(config.output.csv, 'utf8');
  assert.ok(csv.startsWith('\uFEFF'));
  assert.equal(csv.trim().split('\r\n').length, 3, 'header + two channels');

  const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  assert.equal(report.probe.droppedChannels, 1);
  assert.equal(report.validation.ok, true);
  assert.equal(report.sources[0].ok, true);
});

test('existing output is merged on the next run instead of being recreated', async () => {
  const { dir, configPath, config } = workspace();
  assert.equal((await runCli(['--config', configPath, '--report', path.join(dir, 'report.json')])).status, 0);

  const firstRaw = fs.readFileSync(config.output.json, 'utf8');
  const first = JSON.parse(firstRaw);
  assert.equal((await runCli(['--config', configPath, '--report', path.join(dir, 'report.json'), '--merge-existing'])).status, 0);
  const secondRaw = fs.readFileSync(config.output.json, 'utf8');
  const second = JSON.parse(secondRaw);

  assert.equal(secondRaw, firstRaw, 'an unchanged catalog is not rewritten (no daily commit churn)');

  assert.equal(second.count, first.count);
  assert.deepEqual(
    second.channels.map((channel) => channel.channel_id).sort(),
    first.channels.map((channel) => channel.channel_id).sort(),
    'IDs stay stable across runs',
  );
});

test('guardrails refuse to publish when the catalog is too small', async () => {
  const { dir, configPath } = workspace();
  const result = await runCli(['--config', configPath, '--min-channels', '50', '--report', path.join(dir, 'report.json')]);

  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /only 2 channels/);
  assert.equal(fs.existsSync(path.join(dir, 'channels.json')), false, 'nothing is published on failure');
});

test('dry run reports without writing the catalog', async () => {
  const { dir, configPath, config } = workspace();
  const result = await runCli(['--config', configPath, '--dry-run', '--report', path.join(dir, 'report.json')]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(config.output.json), false);
  assert.equal(fs.existsSync(config.output.csv), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')).dryRun, true);
});
