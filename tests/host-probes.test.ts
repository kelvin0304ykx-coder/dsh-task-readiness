import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../src/core/diagnose.ts';
import { parseIntent } from '../src/core/intent.ts';
import { createProbeExecutor, SUPPORTED_PROBES, probeLimitation, supportsProbe } from '../src/host/probes.ts';
import type { ActionPlan } from '../src/core/actions.ts';
import type { Capability, Report, SessionSnapshot } from '../src/core/types.ts';
import type { CheckContext } from '../src/host/service.ts';
import type { HostContext } from '../src/host/snapshot.ts';
const now = Date.parse('2026-11-13T09:00:00Z');
const at = new Date(now).toISOString();
function reportFor(capability: Capability, extra: Record<string, unknown> = {}): Report {
  const intent = parseIntent({ version: 1, title: 'Synthetic', requirements: [{ id: 'r', capability }], files: [], ...extra });
  const snapshot: SessionSnapshot = {
    sessionId: 'session-a', stamp: 'stamp-1', observedAt: at, scope: 'step',
    route: { provider: 'p', model: 'm' }, cwd: '/work', sandbox: 'workspace-write', approval: 'ask',
    facts: { [capability]: { availability: 'available', preconditions: 'satisfied', reasonCodes: ['TOOL_ADMITTED'], evidence: [] } },
  };
  return diagnose(intent, snapshot, now);
}
function planFor(report: Report, probeId: Capability): ActionPlan {
  return { id: 'action-1', revision: 1, sessionId: report.sessionId, reportId: report.id, reportRevision: 1, binding: report.binding, request: { kind: 'probe', probeId, requirementId: 'r' }, digest: 'd', createdAt: at, expiresAt: at, status: 'confirmed', cost: 'none', effects: [] };
}
interface Calls { writes: Array<{ path: string; content: string; intent: unknown }>; deletes: string[]; reads: Array<{ path: string; length: number }>; fetches: string[]; searches: Array<{ query: string; maxResults?: number }>; office: string[] }
function makeHost(parts: { fs?: Record<string, unknown>; web?: Record<string, unknown>; office?: Record<string, unknown>; policy?: unknown }, calls: Calls): HostContext {
  const host: HostContext = {
    fs: parts.fs, web: parts.web, officeKit: parts.office,
    workingDirectory: { get: () => '/work' },
    sandboxPolicy: { resolve: () => parts.policy ?? { mode: 'workspace-write', workspaceRoot: '/work' } },
  };
  host.get = (name: string) => host[name];
  void calls;
  return host;
}
function context(host: HostContext, signal = new AbortController().signal): CheckContext {
  return { agent: { id: 'session-a', ctx: host, session: {} }, toolSet: {}, signal, toolName: 'readiness_probe' };
}
function calls(): Calls { return { writes: [], deletes: [], reads: [], fetches: [], searches: [], office: [] }; }
function fileSystem(state: { bytes?: Uint8Array; writeError?: string; deleteError?: string; stat?: 'file' | 'directory' | undefined }) {
  const targets = new Map<string, { displayPath: string }>();
  const store = new Map<string, Uint8Array>();
  return {
    resolve: async (path: string) => { if (!targets.has(path)) targets.set(path, { displayPath: path.startsWith('/') ? path : '/work/' + path }); return targets.get(path)!; },
    stat: async (target: { displayPath: string }) => { const type = state.stat === undefined ? (target.displayPath.endsWith('/') ? 'directory' : 'file') : state.stat; return type === undefined ? undefined : { type, version: 'v0', size: state.bytes?.length ?? 4 }; },
    processPath: (target: { displayPath: string }) => target.displayPath,
    contains: (a: { displayPath: string }, b: { displayPath: string }) => b.displayPath === a.displayPath || b.displayPath.startsWith(a.displayPath + '/'),
    readByteRange: async (target: { displayPath: string }, range: { offset: number; length: number }) => { const bytes = store.get(target.displayPath) ?? state.bytes ?? new Uint8Array([1, 2, 3, 4]); return bytes.slice(range.offset, range.offset + range.length); },
    writeText: async (target: { displayPath: string }, content: string, intent: unknown) => { if (state.writeError) throw new Error(state.writeError); store.set(target.displayPath, new TextEncoder().encode(content)); return { operation: 'create', version: 'v1', before: null, after: content }; },
    deleteFile: async (target: { displayPath: string }) => { if (state.deleteError) throw new Error(state.deleteError); return { removed: true }; },
  };
}
async function run(capability: Capability, options: { report?: Report; host?: HostContext; signal?: AbortSignal; executorOptions?: Parameters<typeof createProbeExecutor>[0] } = {}) {
  const report = options.report ?? reportFor(capability);
  const host = options.host ?? makeHost({ fs: fileSystem({}), web: {}, office: {} }, calls());
  const executor = createProbeExecutor(options.executorOptions);
  return executor(context(host, options.signal), planFor(report, capability), report, options.signal ?? new AbortController().signal);
}
test('probe catalogue publishes exactly the capabilities this build can really exercise', () => {
  assert.deepEqual([...SUPPORTED_PROBES], ['files.read', 'files.write', 'web.fetch', 'web.search', 'office.convert', 'office.render', 'office.recalculate']);
  assert.equal(supportsProbe('files.read'), true);
  assert.equal(supportsProbe('browser.read'), false);
  assert.match(probeLimitation('browser.read'), /会话/);
  assert.match(probeLimitation('image.inspect'), /模型/);
});
test('reading a declared input passes only after a bounded byte window is read', async () => {
  const c = calls();
  const fs = fileSystem({ bytes: new Uint8Array(9000).fill(65) });
  const readByteRange = fs.readByteRange;
  fs.readByteRange = async (t, r) => { c.reads.push({ path: t.displayPath, length: r.length }); return readByteRange(t, r); };
  const report = reportFor('files.read', { files: ['notes/a.txt'] });
  const outcome = await run('files.read', { report, host: makeHost({ fs }, c) });
  assert.deepEqual(outcome, { status: 'succeeded', code: 'PROBE_PASSED' });
  assert.equal(c.reads.length, 1);
  assert.ok(c.reads[0].length <= 4096 && c.reads[0].length > 0);
});
test('a refused input read fails the probe instead of reporting a pass', async () => {
  const fs = fileSystem({});
  fs.readByteRange = async () => { throw new Error('denied'); };
  const report = reportFor('files.read', { files: ['secret.txt'] });
  const outcome = await run('files.read', { report, host: makeHost({ fs }, calls()) });
  assert.deepEqual(outcome, { status: 'failed', code: 'PROBE_FAILED' });
});
test('a read probe without declared inputs cannot pass', async () => {
  const outcome = await run('files.read', { report: reportFor('files.read') });
  assert.deepEqual(outcome, { status: 'failed', code: 'PROBE_FAILED' });
});
test('the write probe creates one synthetic file, reads it back and removes it', async () => {
  const c = calls();
  const fs = fileSystem({});
  const writeText = fs.writeText;
  fs.writeText = async (t: { displayPath: string }, content: string, intent: unknown) => { c.writes.push({ path: t.displayPath, content, intent }); return writeText(t, content, intent); };
  fs.deleteFile = async (t: { displayPath: string }) => { c.deletes.push(t.displayPath); return { removed: true }; };
  const report = reportFor('files.write', { outputDirectory: '/work/out' });
  const outcome = await run('files.write', { report, host: makeHost({ fs }, c) });
  assert.deepEqual(outcome, { status: 'succeeded', code: 'PROBE_PASSED' });
  assert.equal(c.writes.length, 1);
  assert.match(c.writes[0].path, /^\/work\/out\/\.dsh-readiness-probe-[a-f0-9]{16}\.txt$/);
  assert.match(c.writes[0].content, /DSH-READINESS-PROBE-v1/);
  assert.deepEqual(c.writes[0].intent, { kind: 'createIfAbsent' });
  assert.deepEqual(c.deletes, [c.writes[0].path]);
});
test('the write probe passes the resolved session policy to every mutation', async () => {
  const seen: unknown[] = [];
  const fs = fileSystem({});
  const writeText = fs.writeText;
  fs.writeText = async (t: { displayPath: string }, content: string, intent: unknown, signal: unknown, policy: unknown) => { seen.push(policy); return writeText(t, content, intent); };
  fs.deleteFile = async (_t: unknown, _e: unknown, _s: unknown, policy: unknown) => { seen.push(policy); return { removed: true }; };
  const policy = { mode: 'danger-full-access' };
  const report = reportFor('files.write', { outputDirectory: '/work/out' });
  const outcome = await run('files.write', { report, host: makeHost({ fs, policy }, calls()) });
  assert.equal(outcome.status, 'succeeded');
  assert.deepEqual(seen, [policy, policy]);
});
test('a refused write fails the probe and leaves no cleanup call', async () => {
  const c = calls();
  const fs = fileSystem({ writeError: 'FS_SANDBOX_DENIED' });
  const deleted: string[] = [];
  fs.deleteFile = async (t: { displayPath: string }) => { deleted.push(t.displayPath); return { removed: true }; };
  const report = reportFor('files.write', { outputDirectory: '/work/out' });
  const outcome = await run('files.write', { report, host: makeHost({ fs }, c) });
  assert.deepEqual(outcome, { status: 'failed', code: 'PROBE_FAILED' });
  assert.deepEqual(deleted, []);
});
test('a read-only or missing output policy never reaches the filesystem write', async () => {
  for (const policy of [{ mode: 'read-only', workspaceRoot: '/work' }, undefined]) {
    let writes = 0;
    const fs = fileSystem({});
    fs.writeText = async () => { writes++; return { version: 'v1', operation: 'create', before: null, after: '' }; };
    const report = reportFor('files.write', { outputDirectory: '/work/out' });
    const host = makeHost({ fs, policy: policy ?? { mode: 'unknown' } }, calls());
    const outcome = await run('files.write', { report, host });
    assert.deepEqual(outcome, { status: 'failed', code: 'PROBE_FAILED' });
    assert.equal(writes, 0);
  }
});
test('a failed cleanup keeps the write probe unknown rather than claiming success', async () => {
  const fs = fileSystem({ deleteError: 'FS_IO' });
  const report = reportFor('files.write', { outputDirectory: '/work/out' });
  const outcome = await run('files.write', { report, host: makeHost({ fs }, calls()) });
  assert.deepEqual(outcome, { status: 'outcome_unknown', code: 'OUTCOME_UNKNOWN' });
});
test('web fetch passes only for an allowed page with readable content', async () => {
  const fetched: string[] = [];
  const web = { fetch: async (request: { url: string }) => { fetched.push(request.url); return { url: request.url, statusCode: 200, body: { kind: 'html', content: '<h1>Example Domain</h1>' }, truncated: false }; } };
  const outcome = await run('web.fetch', { host: makeHost({ web }, calls()) });
  assert.deepEqual(outcome, { status: 'succeeded', code: 'PROBE_PASSED' });
  assert.deepEqual(fetched, ['https://example.com/']);
});
test('a challenge page returned with HTTP 200 is an access failure, not a pass', async () => {
  const web = { fetch: async (request: { url: string }) => ({ url: request.url, statusCode: 200, body: { kind: 'html', content: '<title>Just a moment...</title>' }, truncated: false }) };
  const outcome = await run('web.fetch', { host: makeHost({ web }, calls()) });
  assert.deepEqual(outcome, { status: 'failed', code: 'PROBE_FAILED' });
});
test('a non-2xx fetch is reported as a failed probe', async () => {
  const web = { fetch: async (request: { url: string }) => ({ url: request.url, statusCode: 503, body: { kind: 'text', content: 'Example Domain' }, truncated: false }) };
  const outcome = await run('web.fetch', { host: makeHost({ web }, calls()) });
  assert.deepEqual(outcome, { status: 'failed', code: 'PROBE_FAILED' });
});
test('a search probe issues exactly one bounded query and needs real sources', async () => {
  const c = calls();
  const web = { search: async (request: { query: string; maxResults?: number }) => { c.searches.push(request); return { sources: [{ url: 'https://example.org/a' }], truncated: false }; } };
  let outcome = await run('web.search', { host: makeHost({ web }, c) });
  assert.deepEqual(outcome, { status: 'succeeded', code: 'PROBE_PASSED' });
  assert.equal(c.searches.length, 1);
  assert.ok((c.searches[0].maxResults ?? 99) <= 3);
  const empty = { search: async (request: { query: string }) => { c.searches.push(request); return { sources: [], truncated: false }; } };
  outcome = await run('web.search', { host: makeHost({ web: empty }, c) });
  assert.deepEqual(outcome, { status: 'failed', code: 'PROBE_FAILED' });
});
test('a missing web service fails the probe instead of reporting unknown health', async () => {
  const outcome = await run('web.fetch', { host: makeHost({}, calls()) });
  assert.deepEqual(outcome, { status: 'failed', code: 'PROBE_FAILED' });
});
test('office conversion runs the bundled synthetic document through the host engine', async () => {
  const seen: string[] = [];
  const office = { convert: async (request: { extension: string; source: { read: (s: AbortSignal, n: number) => Promise<{ bytes: Uint8Array; version: string }> } }) => { const read = await request.source.read(new AbortController().signal, 1_000_000); seen.push(request.extension, Buffer.from(read.bytes).subarray(0, 2).toString('latin1')); return { pdf: new TextEncoder().encode('%PDF-1.7 readiness'), missingFonts: [] }; } };
  const outcome = await run('office.convert', { host: makeHost({ office }, calls()), executorOptions: { loadAsset: async () => new Uint8Array([0x50, 0x4b, 3, 4, 9]) } });
  assert.deepEqual(outcome, { status: 'succeeded', code: 'PROBE_PASSED' });
  assert.deepEqual(seen, ['docx', 'PK']);
});
test('office conversion that returns something other than a PDF fails', async () => {
  const office = { convert: async () => ({ pdf: new TextEncoder().encode('<html>error</html>'), missingFonts: [] }) };
  const outcome = await run('office.convert', { host: makeHost({ office }, calls()), executorOptions: { loadAsset: async () => new Uint8Array([1]) } });
  assert.deepEqual(outcome, { status: 'failed', code: 'PROBE_FAILED' });
});
test('office rendering must return at least one real PNG image', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
  let renders = 0;
  const office = { convert: async () => ({ pdf: new TextEncoder().encode('%PDF-1.7'), missingFonts: [] }), renderImages: async () => { renders++; return { images: [{ png, width: 10, height: 10 }], pageCount: 1, dpi: 72, missingFonts: [] }; } };
  let outcome = await run('office.render', { host: makeHost({ office }, calls()), executorOptions: { loadAsset: async () => new Uint8Array([1]) } });
  assert.deepEqual(outcome, { status: 'succeeded', code: 'PROBE_PASSED' });
  assert.equal(renders, 1);
  const blank = { convert: async () => ({ pdf: new TextEncoder().encode('%PDF-1.7'), missingFonts: [] }), renderImages: async () => ({ images: [], pageCount: 1, dpi: 72, missingFonts: [] }) };
  outcome = await run('office.render', { host: makeHost({ office: blank }, calls()), executorOptions: { loadAsset: async () => new Uint8Array([1]) } });
  assert.deepEqual(outcome, { status: 'failed', code: 'PROBE_FAILED' });
});
test('recalculation requires a non-empty workbook result', async () => {
  const office = { recalculate: async () => ({ path: '/tmp/out.xlsx', bytes: 2048, missingFonts: [] }) };
  let outcome = await run('office.recalculate', { host: makeHost({ office }, calls()), executorOptions: { loadAsset: async () => new Uint8Array([1]) } });
  assert.deepEqual(outcome, { status: 'succeeded', code: 'PROBE_PASSED' });
  const empty = { recalculate: async () => ({ path: '/tmp/out.xlsx', bytes: 0, missingFonts: [] }) };
  outcome = await run('office.recalculate', { host: makeHost({ office: empty }, calls()), executorOptions: { loadAsset: async () => new Uint8Array([1]) } });
  assert.deepEqual(outcome, { status: 'failed', code: 'PROBE_FAILED' });
});
test('a capability without a real probe returns an unsupported, not a failed, result', async () => {
  let touched = 0;
  const host = makeHost({ fs: { resolve: async () => { touched++; return { displayPath: '/x' }; } } }, calls());
  const report = reportFor('browser.read');
  const outcome = await run('browser.read', { report, host });
  assert.deepEqual(outcome, { status: 'outcome_unknown', code: 'PROBE_UNSUPPORTED' });
  assert.equal(touched, 0);
});
test('a cancelled signal short-circuits before any host call', async () => {
  const controller = new AbortController();
  controller.abort();
  let touched = 0;
  const fs = fileSystem({});
  fs.readByteRange = async () => { touched++; return new Uint8Array([1]); };
  const report = reportFor('files.read', { files: ['a.txt'] });
  const outcome = await run('files.read', { report, host: makeHost({ fs }, calls()), signal: controller.signal });
  assert.deepEqual(outcome, { status: 'cancelled', code: 'PROBE_CANCELLED' });
  assert.equal(touched, 0);
});
test('host error text never becomes the probe result', async () => {
  const web = { fetch: async () => { throw new Error('token sk-live-123 at private.corp'); } };
  const outcome = await run('web.fetch', { host: makeHost({ web }, calls()) });
  assert.deepEqual(Object.keys(outcome).sort(), ['code', 'status']);
  assert.ok(!JSON.stringify(outcome).includes('sk-live'));
});

test('a missing or unreadable probe fixture fails instead of reporting a pass', async () => {
  const office = { convert: async () => ({ pdf: new TextEncoder().encode('%PDF-1.7'), missingFonts: [] }) };
  const outcome = await run('office.convert', { host: makeHost({ office }, calls()), executorOptions: { loadAsset: async () => { throw new Error('ENOENT'); } } });
  assert.deepEqual(outcome, { status: 'failed', code: 'PROBE_FAILED' });
});
test('an engine error fails the probe and never leaks the engine text', async () => {
  const office = { convert: async () => { throw new Error('LibreOffice failed: /Users/someone/secret.docx'); } };
  const outcome = await run('office.convert', { host: makeHost({ office }, calls()), executorOptions: { loadAsset: async () => new Uint8Array([1]) } });
  assert.deepEqual(outcome, { status: 'failed', code: 'PROBE_FAILED' });
  assert.ok(!JSON.stringify(outcome).includes('secret.docx'));
});
test('an abort during the write probe is reported as cancelled, never as success', async () => {
  const controller = new AbortController();
  const fs = fileSystem({});
  fs.writeText = async () => { controller.abort(); throw new Error('aborted'); };
  const report = reportFor('files.write', { outputDirectory: '/work/out' });
  const outcome = await run('files.write', { report, host: makeHost({ fs }, calls()), signal: controller.signal });
  assert.deepEqual(outcome, { status: 'cancelled', code: 'PROBE_CANCELLED' });
});
test('a write probe without an output directory cannot pass', async () => {
  const fs = fileSystem({});
  let writes = 0;
  fs.writeText = async () => { writes += 1; return { version: 'v1', operation: 'create', before: null, after: '' }; };
  const outcome = await run('files.write', { report: reportFor('files.write'), host: makeHost({ fs }, { writes: [], deletes: [], reads: [], fetches: [], searches: [], office: [] }) });
  assert.deepEqual(outcome, { status: 'failed', code: 'PROBE_FAILED' });
  assert.equal(writes, 0);
});
test('task text cannot redirect the fetch probe to another address', async () => {
  const fetched: string[] = [];
  const web = { fetch: async (request: { url: string }) => { fetched.push(request.url); return { url: request.url, statusCode: 200, body: { kind: 'html', content: 'Example Domain' }, truncated: false }; } };
  const report = reportFor('web.fetch', { files: ['http://169.254.169.254/latest/meta-data/', 'https://internal.example/'] });
  const outcome = await run('web.fetch', { report, host: makeHost({ web }, calls()) });
  assert.deepEqual(outcome, { status: 'succeeded', code: 'PROBE_PASSED' });
  assert.deepEqual(fetched, ['https://example.com/']);
});
