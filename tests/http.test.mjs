import assert from 'node:assert/strict';
import http from 'node:http';
import test, { after, before } from 'node:test';

import { fetchText, isPublicHttpUrl, probeStream } from '../scripts/lib/http.mjs';

const HLS_BODY = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment1.ts\n';
const HTML_BODY = '<!doctype html><html><body>not a stream</body></html>';

let server;
let baseUrl;

before(async () => {
  server = http.createServer((request, response) => {
    const url = request.url ?? '/';
    if (url === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('User-agent: *\nDisallow: /private\nAllow: /private/ok\n');
      return;
    }
    if (url.startsWith('/playlist.m3u8')) {
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      response.end(HLS_BODY);
      return;
    }
    if (url.startsWith('/page.html')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(HTML_BODY);
      return;
    }
    if (url === '/private/page') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('secret');
      return;
    }
    if (url === '/private/ok/page') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('allowed');
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('missing');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('isPublicHttpUrl blocks loopback, private ranges and non-http schemes', () => {
  assert.equal(isPublicHttpUrl('https://example.com/a.m3u8'), true);
  assert.equal(isPublicHttpUrl('http://127.0.0.1/a.m3u8'), false);
  assert.equal(isPublicHttpUrl('http://localhost/a'), false);
  assert.equal(isPublicHttpUrl('http://10.1.2.3/a'), false);
  assert.equal(isPublicHttpUrl('http://192.168.1.10/a'), false);
  assert.equal(isPublicHttpUrl('http://172.20.0.1/a'), false);
  assert.equal(isPublicHttpUrl('http://[::1]/a'), false);
  assert.equal(isPublicHttpUrl('file:///etc/passwd'), false);
  assert.equal(isPublicHttpUrl('not a url'), false);
});

test('fetchText reads a page and refuses private hosts unless explicitly allowed', async () => {
  const page = await fetchText(`${baseUrl}/page.html`, { allowPrivateHosts: true, respectRobots: false });
  assert.equal(page.status, 200);
  assert.match(page.text, /not a stream/);

  await assert.rejects(() => fetchText(`${baseUrl}/page.html`, { respectRobots: false }), /refusing non-public URL/);
  await assert.rejects(() => fetchText(`${baseUrl}/missing`, { allowPrivateHosts: true, respectRobots: false, retries: 0 }), /HTTP 404/);
});

test('fetchText honours robots.txt rules', async () => {
  await assert.rejects(
    () => fetchText(`${baseUrl}/private/page`, { allowPrivateHosts: true, respectRobots: true }),
    /robots\.txt/,
  );

  const allowed = await fetchText(`${baseUrl}/private/ok/page`, { allowPrivateHosts: true, respectRobots: true });
  assert.equal(allowed.text, 'allowed');
});

test('probeStream accepts real manifests and rejects HTML pages', async () => {
  const live = await probeStream(`${baseUrl}/playlist.m3u8`, { allowPrivateHosts: true });
  assert.equal(live.ok, true);
  assert.equal(live.status, 200);
  assert.ok(live.latencyMs >= 0);

  const dead = await probeStream(`${baseUrl}/page.html`, { allowPrivateHosts: true });
  assert.equal(dead.ok, false);
  assert.match(dead.error, /HTML page/);

  const missing = await probeStream(`${baseUrl}/nope.m3u8`, { allowPrivateHosts: true });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /HTTP 404/);

  const blocked = await probeStream('http://127.0.0.1/a.m3u8', {});
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /non-public URL/);
});
