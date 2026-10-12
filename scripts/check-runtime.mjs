import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

// Integration test runner only. Never supply remote bindings or provider credentials.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'artifacts/runtime');
await rm(join(output, 'local-smoke.json'), { force: true });
const config = JSON.parse(await readFile(join(root, 'wrangler.runtime.jsonc'), 'utf8'));
const report = JSON.parse(await readFile(join(output, 'build-report.json'), 'utf8'));
const scriptPath = join(output, 'entry.js');
const hash = (body) => createHash('sha256').update(body).digest('hex');
assert.equal(hash(await readFile(scriptPath)), report.worker.sha256, 'The package must match the reviewed build report');

let outboundAttempts = 0;
let checks = 0;
const started = performance.now();
const localOptions = convertV4MiniflareOptions({
  name: 'tooth-talk-staging-local-check',
  host: '127.0.0.1',
  port: 0,
  modules: true,
  scriptPath,
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  bindings: config.vars,
  cf: false,
  log: new Log(LogLevel.ERROR),
  outboundService: () => {
    outboundAttempts += 1;
    throw new Error('Outbound network is forbidden during the local runtime check');
  },
});
const worker = new Miniflare({ ...localOptions, telemetry: { enabled: false } });
try {
  await worker.ready;
  const localBootMilliseconds = Math.round(performance.now() - started);
  const origin = config.vars.APP_ORIGIN;
  function checkHeaders(response) {
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    assert.match(response.headers.get('Content-Security-Policy'), /script-src 'self'/);
    assert.doesNotMatch(response.headers.get('Content-Security-Policy'), /unsafe-inline|unsafe-eval/);
  }
  for (const [path, asset] of Object.entries(report.assets)) {
    const response = await worker.dispatchFetch(origin + path);
    assert.equal(response.status, 200, path);
    checkHeaders(response);
    assert.equal(response.headers.get('Content-Type'), asset.contentType, path);
    assert.equal(response.headers.get('Cache-Control'), path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store', path);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), asset.sha256, path);
    checks += 1;
  }
  for (const path of ['/', '/booking', '/appointments', '/admin', '/contact', '/admin-invitation', '/admin/administrators']) {
    const response = await worker.dispatchFetch(origin + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('Cache-Control'), 'no-store', path);
    checkHeaders(response);
    const body = await response.text();
    assert.equal(hash(body), report.assets['/index.html'].sha256, path);
    assert.match(body, /src="\/assets\/[^"]+\.js"/, path);
    assert.match(body, /<title>ToothTalk · Synthetic Staging<\/title>/);
    checks += 1;
  }
  // Inspect the exact bytes served by workerd, not the source tree or demo build.
  for (const path of Object.keys(report.assets).filter(path => path.endsWith('.js'))) {
    const response = await worker.dispatchFetch(origin + path);
    const javascript = await response.text();
    for (const canary of ['AD-DEMO-A', 'AD-DEMO-OWNER', 'AC-DEMO-B', 'adminBrowserFixture', 'synthetic-browser-id-token']) {
      assert.ok(!javascript.includes(canary), 'Production assets must exclude demo identities and browser test seams');
    }
    checks += 1;
  }
  for (const path of ['/admin-invitation/extra', '/admin/administrators/extra', '/demo/admin-invitation', '/demo/admin/administrators']) {
    const response = await worker.dispatchFetch(origin + path);
    assert.equal(response.status, 404, 'Only the exact approved new static routes are allowed');
    checks += 1;
  }
  for (const path of ['/api', '/api/session', '/api/missing', '/api/auth/line/start', '/api/admin-invitations/mine', '/api/admin/management/capabilities']) {
    const response = await worker.dispatchFetch(origin + path);
    assert.equal(response.status, 503, path);
    checkHeaders(response);
    assert.equal(response.headers.get('Cache-Control'), 'no-store', path);
    assert.match(response.headers.get('Content-Type'), /^application\/json/);
    assert.equal((await response.json()).error.code, 'UNAVAILABLE', path);
    checks += 1;
  }
  const bootstrap = await worker.dispatchFetch(origin + '/api/auth/liff', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: 'synthetic-local-only' }),
  });
  assert.equal(bootstrap.status, 503);
  assert.equal((await bootstrap.json()).error.code, 'UNAVAILABLE');
  checks += 1;
  for (const path of ['/missing.js', '/assets/missing.js', '/entry.js.map']) {
    const response = await worker.dispatchFetch(origin + path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('Cache-Control'), 'no-store', path);
    checks += 1;
  }
  for (const path of ['/', '/admin-invitation', '/admin/administrators']) {
    const head = await worker.dispatchFetch(origin + path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    checkHeaders(head);
    assert.equal(head.headers.get('Cache-Control'), 'no-store');
    assert.equal(await head.text(), '');
    checks += 1;
  }
  assert.equal(outboundAttempts, 0);
  const result = {
    passed: true, checks, workerSha256: report.worker.sha256,
    runtime: 'local Miniflare/workerd', localBootMilliseconds,
    platformStartupMeasured: false, databaseConnected: false,
    providerRequests: outboundAttempts, deployed: false,
  };
  await writeFile(join(output, 'local-smoke.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  await worker.dispose();
}
