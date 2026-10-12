// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertProductionModuleIds, collectStaticAssets, measureBundle, publicBuildDefines, renderAssetModule, stagingHtml, uploadMetadata } from '../../scripts/build-runtime.mjs';

const temporaryDirectories: string[] = [];
async function fixture(files: Record<string, string | Uint8Array>) {
  const directory = await mkdtemp(join(tmpdir(), 'dental-assets-'));
  temporaryDirectories.push(directory);
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(directory, name, '..'), { recursive: true });
    await writeFile(join(directory, name), body);
  }
  return directory;
}
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('embedded production asset packaging', () => {
  it('labels runtime HTML as synthetic-only staging while leaving the demo source unchanged', async () => {
    const original = await readFile('index.html', 'utf8');
    const html = stagingHtml(original);
    expect(html).toContain('<title>ToothTalk · Synthetic Staging</title>');
    expect(html).toContain('ระบบทดสอบนัดหมายทันตกรรม ใช้ข้อมูลสมมติเท่านั้น ไม่รับข้อมูลผู้ป่วยจริง');
    expect(html).not.toMatch(/Booking Demo|เดโม/);
    expect(await readFile('index.html', 'utf8')).toBe(original);
    expect(() => stagingHtml('<html/>')).toThrow('metadata');
  });

  it('preserves exact UTF-8 text and supplies correct MIME types at absolute paths', async () => {
    const directory = await fixture({ 'index.html': '<h1>ยินดีต้อนรับ</h1>', 'assets/app-abc123.js': 'const quote = "\\n</script>";', 'assets/app-abc123.css': 'body { color: red }', 'favicon.svg': '<svg/>' });
    const assets = await collectStaticAssets(directory);
    expect(assets).toEqual({
      '/index.html': { body: '<h1>ยินดีต้อนรับ</h1>', contentType: 'text/html; charset=utf-8' },
      '/assets/app-abc123.js': { body: 'const quote = "\\n</script>";', contentType: 'text/javascript; charset=utf-8' },
      '/assets/app-abc123.css': { body: 'body { color: red }', contentType: 'text/css; charset=utf-8' },
      '/favicon.svg': { body: '<svg/>', contentType: 'image/svg+xml' },
    });
    expect(assets['/']).toBeUndefined();
  });

  it('requires an index document rather than packaging an empty output', async () => {
    await expect(collectStaticAssets(await fixture({ 'favicon.svg': '<svg/>' }))).rejects.toThrow('index.html');
  });

  it.each(['assets/app.js.map', '.env', 'assets/photo.png', 'api/index.html', 'assets/.hidden.txt'])('refuses unsupported or private file %s', async (name) => {
    await expect(collectStaticAssets(await fixture({ 'index.html': '<html/>', [name]: 'private' }))).rejects.toThrow();
  });

  it('rejects source-map references even when map files were removed', async () => {
    await expect(collectStaticAssets(await fixture({ 'index.html': '<html/>', 'assets/app.js': 'run();\n//# sourceMappingURL=app.js.map' }))).rejects.toThrow('source map');
  });

  it('refuses invalid UTF-8 and symlinks instead of changing bytes or escaping the output directory', async () => {
    await expect(collectStaticAssets(await fixture({ 'index.html': '<html/>', 'assets/app.js': Uint8Array.of(255, 254) }))).rejects.toThrow('UTF-8');
    const directory = await fixture({ 'index.html': '<html/>' });
    await symlink(join(directory, 'index.html'), join(directory, 'copy.html'));
    await expect(collectStaticAssets(directory)).rejects.toThrow('symbolic link');
  });

  it('enforces the total embedded-asset byte budget', async () => {
    await expect(collectStaticAssets(await fixture({ 'index.html': '12345' }), 4)).rejects.toThrow('budget');
  });

  it('renders a deterministic immutable map with escaped strings', async () => {
    const assets = { '/index.html': { body: '"\\\n</script>ยิ้ม', contentType: 'text/html; charset=utf-8' } };
    const source = renderAssetModule(assets);
    expect(source).toContain('export const assets');
    expect(source).toContain('Object.freeze(');
    expect(source).toContain(JSON.stringify(assets['/index.html'].body));
    expect(source).toBe(renderAssetModule(assets));
    const directory = await fixture({ 'assets.ts': source });
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `const { assets } = await import(${JSON.stringify(pathToFileURL(join(directory, 'assets.ts')).href)}); console.log(JSON.stringify({ assets, frozen: Object.isFrozen(assets) && Object.isFrozen(assets['/index.html']) }));`], { encoding: 'utf8' });
    expect(imported.status, imported.stderr).toBe(0);
    expect(JSON.parse(imported.stdout)).toEqual({ assets, frozen: true });
  });

  it.each(['/project/src/demo/fixtures.ts', '/project/src/demo/api.ts?x=1', '/project/tests/support/example.ts', 'C:\\project\\src\\demo\\DemoApp.tsx'])('rejects non-production graph input %s', (id) => {
    expect(() => assertProductionModuleIds([id])).toThrow('Non-production');
  });

  it('accepts real UI and runtime graph inputs', () => {
    expect(() => assertProductionModuleIds(['/project/src/web/production.tsx', '/project/src/worker/runtime.ts', '/project/node_modules/react/index.js'])).not.toThrow();
  });

  it('reports exact raw/gzip size and hash while enforcing both project budgets', () => {
    const source = Buffer.from('export default { fetch() {} };');
    const result = measureBundle(source, 100, 100);
    expect(result).toMatchObject({ bytes: source.byteLength, gzipBytes: gzipSync(source).byteLength });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => measureBundle(source, 1, 100)).toThrow('budget');
    expect(() => measureBundle(source, 100, 1)).toThrow('budget');
  });
});

describe('runtime deployment configuration', () => {
  it('produces safe multipart metadata without inventing resource bindings', async () => {
    const config = JSON.parse(await readFile('wrangler.runtime.jsonc', 'utf8'));
    const metadata = uploadMetadata(config);
    expect(metadata).toMatchObject({ main_module: 'entry.js', compatibility_flags: ['nodejs_compat'], logpush: false, observability: { enabled: false }, keep_bindings: ['secret_text'] });
    expect(metadata.bindings).toHaveLength(Object.keys(config.vars).length);
    expect(metadata.bindings.every((binding: { type: string }) => binding.type === 'plain_text')).toBe(true);
    expect(metadata).not.toHaveProperty('assets');
    expect(() => uploadMetadata({ ...config, vars: { ...config.vars, LINE_CHANNEL_SECRET: 'must not package' } })).toThrow('public variables');
    expect(() => uploadMetadata({ ...config, hyperdrive: [{ binding: 'DENTAL_DB', id: 'invented-placeholder' }] })).toThrow('Hyperdrive');
    expect(() => uploadMetadata({ ...config, preview_urls: true })).toThrow('disabled');
  });

  it('exposes only validated LIFF/stage values from explicit config', () => {
    expect(publicBuildDefines({ vars: { LINE_LIFF_ID: '1234567890-Example', LINE_CHANNEL_ID: '1234567890', APP_STAGE: 'synthetic-staging', EXTRA_SECRET: 'never expose me' } })).toEqual({
      'import.meta.env.VITE_LIFF_ID': JSON.stringify('1234567890-Example'),
      'import.meta.env.VITE_APP_STAGE': JSON.stringify('synthetic-staging'),
    });
  });

  it.each(['https://line.me/R/ti/p/@synthetic-clinic','https://line.me/R/ti/p/%40synthetic-clinic','https://lin.ee/Synthetic42'])('packages only an explicitly verified OA URL %s', async url => {
    const config = JSON.parse(await readFile('wrangler.runtime.jsonc', 'utf8'));
    config.vars.LINE_VERIFIED_OA_URL = url;
    expect(publicBuildDefines(config)['import.meta.env.VITE_VERIFIED_LINE_OA_URL']).toBe(JSON.stringify(url));
    expect(uploadMetadata(config).bindings).toContainEqual({type:'plain_text',name:'LINE_VERIFIED_OA_URL',text:url});
  });
  it.each(['https://evil.example/clinic','https://line.me/R/ti/p/@clinic?patient=private','https://lin.ee/Test#private','https://user:pass@lin.ee/Test','https://lin.ee:443/Test','http://lin.ee/Test','https://lin.ee/Test/extra'])('rejects unsafe OA build URL %s before packaging', async url => {
    const config = JSON.parse(await readFile('wrangler.runtime.jsonc', 'utf8'));
    config.vars.LINE_VERIFIED_OA_URL = url;
    expect(() => publicBuildDefines(config)).toThrow('verified OA');
    expect(() => uploadMetadata(config)).toThrow('verified OA');
  });

  it.each([
    {},
    { vars: { LINE_LIFF_ID: '1234567890-Example', LINE_CHANNEL_ID: '1234567890', APP_STAGE: 'production' } },
    { vars: { LINE_LIFF_ID: 'another-channel-value', LINE_CHANNEL_ID: '1234567890', APP_STAGE: 'synthetic-staging' } },
    { vars: { LINE_LIFF_ID: '1234567800-Example', LINE_CHANNEL_ID: '1234567890', APP_STAGE: 'synthetic-staging' } },
  ])('rejects missing or incompatible public build config', (config) => {
    expect(() => publicBuildDefines(config)).toThrow('public staging configuration');
  });

  it('rejects deployment arguments before attempting any build', () => {
    const result = spawnSync(process.execPath, ['scripts/build-runtime.mjs', '--deploy'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not accept deployment arguments');
    expect(result.stdout).toBe('');
  });
  it('keeps logs, previews, maps, telemetry and separate asset uploads disabled without fake bindings', async () => {
    const config = JSON.parse(await readFile('wrangler.runtime.jsonc', 'utf8'));
    expect(config).toMatchObject({ name: 'tooth-talk-staging', main: 'src/worker/entry.ts', compatibility_flags: ['nodejs_compat'], preview_urls: false, logpush: false, upload_source_maps: false, send_metrics: false, observability: { enabled: false, logs: { enabled: false, invocation_logs: false }, traces: { enabled: false } } });
    expect(config).not.toHaveProperty('assets');
    expect(config).not.toHaveProperty('hyperdrive');
    expect(JSON.stringify(config)).not.toMatch(/password|secret|postgres:\/\//i);
  });
});

it('allows explicitly reviewed public bot diagnostic gates but never Messaging credentials',async()=>{
 const config=JSON.parse(await readFile('wrangler.runtime.jsonc','utf8'));
 const vars={...config.vars,LINE_BOT_INFO_ENABLED:'true',LINE_MESSAGING_BASIC_ID:'@example-clinic'};
 expect(uploadMetadata({...config,vars}).bindings).toEqual(expect.arrayContaining([{type:'plain_text',name:'LINE_BOT_INFO_ENABLED',text:'true'},{type:'plain_text',name:'LINE_MESSAGING_BASIC_ID',text:'@example-clinic'}]));
 for(const name of ['LINE_MESSAGING_ACCESS_TOKEN','LINE_MESSAGING_CHANNEL_SECRET'])expect(()=>uploadMetadata({...config,vars:{...vars,[name]:'never-package'}})).toThrow('public variables');
 expect(publicBuildDefines({...config,vars})).not.toHaveProperty('import.meta.env.LINE_BOT_INFO_ENABLED');
});
it('permits only an explicitly reviewed manual approval gate without enabling it by default',async()=>{const config=JSON.parse(await readFile('wrangler.runtime.jsonc','utf8'));expect(config.vars.LINE_MANUAL_APPROVAL_ENABLED).toBeUndefined();expect(uploadMetadata({...config,vars:{...config.vars,LINE_MANUAL_APPROVAL_ENABLED:'true'}}).bindings).toContainEqual({type:'plain_text',name:'LINE_MANUAL_APPROVAL_ENABLED',text:'true'});});

it('packages only the two public combined gates and keeps both absent by default',async()=>{
 const config=JSON.parse(await readFile('wrangler.runtime.jsonc','utf8'));
 expect(config.vars.COMBINED_NOTIFICATIONS_ENABLED).toBeUndefined();expect(config.vars.NOTIFICATION_READINESS_ENABLED).toBeUndefined();
 expect(uploadMetadata({...config,vars:{...config.vars,COMBINED_NOTIFICATIONS_ENABLED:'false',NOTIFICATION_READINESS_ENABLED:'false'}}).bindings).toEqual(expect.arrayContaining([{type:'plain_text',name:'COMBINED_NOTIFICATIONS_ENABLED',text:'false'},{type:'plain_text',name:'NOTIFICATION_READINESS_ENABLED',text:'false'}]));
});
