import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8');
test('the package declares an exact host baseline instead of a drifting range', () => {
  assert.equal(pkg.name, 'dsh-task-readiness');
  assert.equal(pkg.private, true);
  assert.equal(pkg.engines.dsh, '0.2.2-rc.2');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, './lib/index.js');
});
test('the bundle patch inserts exactly this package once and stays declarative', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  const entries = [...patch.matchAll(/- id:\s*([A-Za-z0-9_-]+)\s*\n\s*name:\s*'?([^'\n]+)'?/g)].map((match) => ({ id: match[1], name: match[2] }));
  assert.deepEqual(entries, [{ id: 'task-readiness', name: pkg.name }]);
  assert.ok(!/!!js|!!include|del:|update:/.test(patch));
});
test('every exported subpath resolves to a shipped file', async () => {
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const value = typeof target === 'string' ? target : target.default;
    assert.equal(typeof value, 'string', 'exports.' + subpath);
    if (value === './lib/index.js') continue; // build output, produced by scripts/build.mjs
    await readFile(new URL(value.replace(/^\.\//, ''), root));
  }
});
test('only the tool schema peers are required and no build tool leaks into runtime deps', () => {
  assert.deepEqual(Object.keys(pkg.dependencies), ['zod']);
  for (const peer of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-storage-domain', '@deepseek-ai/cordis']) assert.ok(Object.hasOwn(pkg.peerDependencies, peer), peer);
  for (const runtimeOnly of ['typescript', 'esbuild', '@types/node']) {
    assert.ok(!Object.hasOwn(pkg.dependencies ?? {}, runtimeOnly));
    assert.ok(Object.hasOwn(pkg.devDependencies, runtimeOnly), runtimeOnly);
  }
});
test('the published file list ships the built entry, the patch and the synthetic probe assets', () => {
  assert.ok(pkg.files.includes('lib/**/*.js'));
  assert.ok(pkg.files.includes('cordis.patch.yml'));
  assert.ok(pkg.files.includes('assets/*'));
  assert.ok(pkg.files.includes('README.md'));
});
