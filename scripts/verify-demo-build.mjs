import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const demoDirectory = process.argv[2] ?? 'dist';
const productionDirectory = process.argv[3] ?? 'artifacts/production-dist';
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
function inspect(directory) {
  const paths = files(directory);
  const text = paths.map(path => readFileSync(path, 'utf8')).join('\n');
  assert(paths.every(path => /\.(html|js|css|svg)$/.test(path)), 'Unexpected nonpublic file in static artifact');
  assert(!/(?:SUPABASE_SERVICE_ROLE_KEY|LINE_CHANNEL_ACCESS_TOKEN|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{24,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.test(text), 'Potential secret marker in public artifact');
  const html = readFileSync(join(directory, 'index.html'), 'utf8');
  assert(html.includes('<title>ToothTalk Booking Demo</title>'), 'Requested browser title missing');
  const resources = Array.from(html.matchAll(/(?:src|href)="([^"]+)"/g), match => match[1]);
  assert(resources.length >= 3, 'Missing static resource graph');
  for (const resource of resources) {
    assert(resource.startsWith('/') && !resource.startsWith('//'), `External resource in HTML: ${resource}`);
    assert(paths.includes(join(directory, resource.slice(1))), `Missing local resource: ${resource}`);
  }
  return { text, count: paths.length };
}
const demo = inspect(demoDirectory);
const production = inspect(productionDirectory);
for (const marker of ['ผู้ดูแลจำลอง', 'คุณยิ้ม ทดลอง', '/api/demo/reminders', 'fictional.invalid']) {
  assert(demo.text.includes(marker), `Missing functioning demo marker: ${marker}`);
  assert(!production.text.includes(marker), `Demo adapter/identity marker in production: ${marker}`);
}
assert(production.text.includes('ระบบนัดหมายยังไม่เปิดใช้งาน'), 'Production must remain closed to patient intake');
console.log(`PASS: ${demo.count} public demo files and ${production.count} production files; HTML resources local, secret-pattern scan clear, simulated identity/adapter absent from production.`);
console.log('Static checks only: no browser/network runtime, real security, database concurrency or hosting assertion.');
