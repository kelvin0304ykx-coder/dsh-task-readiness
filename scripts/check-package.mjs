import { readFile, readdir, stat } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const problems = [];
const notes = [];
function fail(message) { problems.push(message); }
async function text(relative) { return readFile(new URL(relative, root), 'utf8'); }
async function size(relative) { try { return (await stat(new URL(relative, root))).size; } catch { return 0; } }
const pkg = JSON.parse(await text('package.json'));
if (pkg.private !== true) fail('package must stay private until publication is authorized');
if (typeof pkg.engines?.dsh !== 'string' || !/^\d+\.\d+\.\d+/.test(pkg.engines.dsh)) fail('engines.dsh must pin an exact host version');
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('dsh.bundle.patch must point at ./cordis.patch.yml');
if (pkg.main !== './lib/index.js') fail('main must be ./lib/index.js');
if (!pkg.exports?.['.']?.default) fail('exports["."] must declare the host entry');
for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
  const value = typeof target === 'string' ? target : target?.default;
  if (typeof value !== 'string') { fail('exports.' + subpath + ' has no string target'); continue; }
  if (await size(value.replace(/^\.\//, '')) === 0) fail('exports.' + subpath + ' target is missing: ' + value);
}
const patch = await text('cordis.patch.yml');
const entries = [...patch.matchAll(/- id:\s*([A-Za-z0-9_-]+)\s*\n\s*name:\s*'?([^'\n]+)'?/g)].map((match) => ({ id: match[1], name: match[2] }));
if (entries.length !== 1) fail('cordis.patch.yml must insert exactly one plugin entry, found ' + entries.length);
else {
  if (entries[0].name !== pkg.name) fail('patch entry name must be the package name, found ' + entries[0].name);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(entries[0].id)) fail('patch entry id is not a stable lowercase id');
}
if (/!!js|!!include|del:|update:/.test(patch)) fail('cordis.patch.yml must stay a plain insert without executable YAML tags');
const built = await text('lib/index.js');
if (built.length < 2000) fail('lib/index.js looks too small');
for (const marker of ['readiness_check', 'readiness_probe', 'readiness_remedy', "export {"]) if (!built.includes(marker)) fail('lib/index.js is missing ' + marker);
if (built.includes('tests/')) fail('built bundle leaks test paths');
if (/\/Users\//.test(built)) fail('built bundle embeds an absolute home directory');
for (const asset of ['assets/probe.docx', 'assets/probe.xlsx']) {
  const bytes = await size(asset);
  if (bytes === 0) fail('missing synthetic probe asset ' + asset);
  else notes.push(asset + ' ' + bytes + ' bytes');
}
if ((await size('assets/probe.png')) > 0) notes.push('assets/probe.png present');
const scannable = ['package.json', 'cordis.patch.yml', 'README.md', 'lib/index.js'];
for (const relative of scannable) {
  let content = '';
  try { content = await text(relative); } catch { continue; }
  for (const pattern of [/(^|[^A-Za-z0-9])sk-[A-Za-z0-9]{16,}/, /@qq\.com/, /57269081/, /\/Users\/[^/\s]+/]) {
    if (pattern.test(content)) fail('possible private material in ' + relative + ': ' + pattern);
  }
}
for (const name of await readdir(new URL('lib/', root))) if (name.endsWith('.ts')) fail('lib must not ship TypeScript sources');
if (!(await readdir(new URL('lib/', root))).includes('index.js')) fail('lib/index.js missing');
console.log(JSON.stringify({ ok: problems.length === 0, package: { name: pkg.name, version: pkg.version, dsh: pkg.engines.dsh }, entries, notes, problems }, null, 2));
if (problems.length > 0) process.exitCode = 1;
