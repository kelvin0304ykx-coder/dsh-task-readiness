/**
 * Real Office engine probe: constructs the host's OfficeKit provider from the
 * installed app tree, converts/renders/recalculates the synthetic fixtures that
 * ship with this plugin, and then runs the plugin's own probe adapter against
 * that real service. Local process only: no network, no user documents, all
 * outputs land in a throwaway directory under the OS temp root.
 * Usage: ELECTRON_RUN_AS_NODE=1 <Electron> office-engine-probe.mjs <SDK root> <plugin project> <output json>
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [sdkRootArg, projectArg, outArg] = process.argv.slice(2);
const sdkRoot = resolve(sdkRootArg);
const project = resolve(projectArg);
const load = (path) => import(pathToFileURL(resolve(sdkRoot, path)).href);
const results = [];
async function check(name, run) {
  const started = Date.now();
  try { const observation = await run(); results.push({ name, status: 'passed', observation, ms: Date.now() - started }); }
  catch (error) { results.push({ name, status: 'failed', error: String(error && error.message ? error.message : error).slice(0, 400), ms: Date.now() - started }); }
}
const { Context } = await load('cordis/lib/index.js');
const { default: OfficeKit } = await load('dsh-office-kit/lib/index.js');
const { createProbeExecutor } = await import(pathToFileURL(resolve(project, 'src/host/probes.ts')).href);
const outputDirectory = await mkdtemp(join(tmpdir(), 'dsh-office-probe-'));
const config = OfficeKit.Config({ outputDirectory });
const context = new Context();
let kit;
await check('the real OfficeKit provider mounts on a Cordis context', async () => {
  await context.plugin(OfficeKit, config);
  kit = context.get('officeKit');
  assert.ok(kit, 'officeKit service missing after mount');
  return 'Provider mounted with an isolated output directory: ' + outputDirectory;
});
const docx = new Uint8Array(await readFile(join(project, 'assets/probe.docx')));
const xlsx = new Uint8Array(await readFile(join(project, 'assets/probe.xlsx')));
const source = (name, bytes) => ({ key: 'readiness-probe/' + name, version: 'probe-v1', bytes: bytes.length, read: async () => ({ bytes, version: 'probe-v1' }) });
const timeout = (ms) => AbortSignal.timeout(ms);
let pdf;
await check('a synthetic docx converts to a real PDF', async () => {
  assert.ok(kit, 'OfficeKit unavailable');
  const result = await kit.convert({ extension: 'docx', priority: 'foreground', source: source('docx', docx) }, timeout(180000));
  pdf = result.pdf;
  assert.ok(pdf instanceof Uint8Array && pdf.length > 1000, 'pdf too small: ' + (pdf && pdf.length));
  assert.equal(Buffer.from(pdf.subarray(0, 5)).toString('latin1'), '%PDF-');
  return 'PDF bytes: ' + pdf.length + ', missing fonts: ' + JSON.stringify(result.missingFonts);
});
await check('the converted PDF renders a real PNG page', async () => {
  assert.ok(pdf, 'conversion did not produce a PDF');
  const result = await kit.renderImages({ extension: 'pdf', source: source('pdf', pdf), dpi: 72, maxImages: 1, maxPixels: 640000, maxDimension: 1024, maxBytes: 2000000 }, timeout(180000));
  const first = result.images[0];
  assert.ok(first && first.png.length > 100, 'no rendered image');
  assert.deepEqual([...first.png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return 'PNG ' + first.width + 'x' + first.height + ', pageCount ' + result.pageCount;
});
await check('a synthetic workbook recalculates', async () => {
  assert.ok(kit, 'OfficeKit unavailable');
  const result = await kit.recalculate({ extension: 'xlsx', format: 'xlsx', source: source('xlsx', xlsx), output: { owner: 'readiness-probe', name: 'recalculated.xlsx' } }, timeout(180000));
  assert.ok(result.bytes > 0, 'empty workbook result');
  return 'Workbook bytes: ' + result.bytes + ', path present: ' + (typeof result.path === 'string');
});
const hostContext = {
  officeKit: kit,
  workingDirectory: { get: () => '/work' },
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/work' }) },
  get(name) { return hostContext[name]; },
};
function probeReport(capability) {
  return { version: 1, id: 'report-probe', revision: 1, sessionId: 'probe-session', binding: 'b'.repeat(64), generatedAt: new Date().toISOString(), status: 'ready_unverified', intent: { version: 1, title: 'Synthetic office probe', requirements: [{ id: 'r', capability }], routes: [{ id: 'primary', requires: ['r'] }], files: [] }, checks: [], routes: [], boundary: 'probe' };
}
const executor = createProbeExecutor({ loadAsset: async (name) => new Uint8Array(await readFile(join(project, 'assets/probe.' + name))) });
for (const capability of ['office.convert', 'office.render', 'office.recalculate']) {
  await check('the plugin adapter passes its own ' + capability + ' probe against the real engine', async () => {
    const report = probeReport(capability);
    const plan = { request: { kind: 'probe', probeId: capability, requirementId: 'r' } };
    const signal = timeout(180000);
    const outcome = await executor({ agent: { id: 'probe-session', ctx: hostContext, session: {} }, signal, toolName: 'readiness_probe' }, plan, report, signal);
    assert.deepEqual(outcome, { status: 'succeeded', code: 'PROBE_PASSED' });
    return 'Outcome: ' + JSON.stringify(outcome);
  });
}
const summary = { schema: 'dsh-readiness-office-probe/v1', sdkVersion: '0.2.2-rc.2', runtime: process.version, generatedAt: new Date().toISOString(), scope: 'Real OfficeKit provider and prebuilt LibreOffice engine from the installed app; synthetic fixtures shipped with the plugin; throwaway output directory; no network or user documents.', outputDirectory, passed: results.filter((item) => item.status === 'passed').length, failed: results.filter((item) => item.status === 'failed').length, results };
if (outArg) await writeFile(outArg, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
if (summary.failed) process.exitCode = 1;
