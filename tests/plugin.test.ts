import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name as pluginName, inject } from '../src/index.ts';
import type { JournalRecord } from '../src/core/journal.ts';
const now = Date.now();
interface ToolDef {
  name: string; description?: string; execute(args: unknown, exec: unknown): Promise<unknown>;
  output: { render(args: unknown, value: unknown): Array<{ type: string; text?: string }>; presentationMeta?(args: unknown, value: unknown): unknown };
  presentCall?(args: unknown): { card: string; title?: string; kind?: string; locations?: Array<{ path: string }> } | undefined;
  presentResult?(args: unknown, result: { content: unknown[]; isError: boolean; meta?: unknown }): { card: string; title?: string; content?: Array<{ type: string; text?: string }> } | undefined;
}
interface CallLog { approvals: number; probes: number; writes: number; version: string }
function memoryTable() {
  const rows = new Map<string, JournalRecord>();
  return { get: (key: string) => rows.get(key), put: async (key: string, value: JournalRecord) => { rows.set(key, value); }, delete: async (key: string) => rows.delete(key), entries: () => rows.entries(), get size() { return rows.size; } };
}
function makeHost(options: { approval?: string; storage?: boolean } = {}) {
  const tools = new Map<string, ToolDef>();
  const commands = new Map<string, { name: string; description: string; handler: (invocation: { agent: { id?: string }; rawInput: string }) => unknown }>();
  const listeners = new Map<string, (...args: never[]) => unknown>();
  const calls: CallLog = { approvals: 0, probes: 0, writes: 0, version: 'v1' };
  const table = memoryTable();
  const fs = {
    resolve: async (path: string) => ({ displayPath: path.startsWith('/') ? path : '/work/' + path }),
    stat: async (target: { displayPath: string }) => ({ type: (target.displayPath.split('/').pop() ?? '').includes('.') ? 'file' : 'directory', version: calls.version, size: 4 }),
    processPath: (target: { displayPath: string }) => target.displayPath,
    contains: (a: { displayPath: string }, b: { displayPath: string }) => b.displayPath === a.displayPath || b.displayPath.startsWith(a.displayPath + '/'),
    readByteRange: async (_t: unknown, range: { offset: number; length: number }) => { if (range.length > 1) calls.probes++; return new Uint8Array(range.length).fill(65); },
    writeText: async (_t: unknown, content: string) => { calls.writes++; calls.probes++; return { operation: 'create', version: 'v1', before: null, after: content }; },
    deleteFile: async () => ({ removed: true }),
  };
  const host: Record<string, unknown> = {
    tools: { register: (definition: ToolDef) => { tools.set(definition.name, definition); return () => tools.delete(definition.name); }, schemas: () => [{ name: 'read', parameters: {} }, { name: 'write', parameters: {} }, { name: 'read_image', parameters: {} }, { name: 'web_search', parameters: {} }, { name: 'web_fetch', parameters: {} }, { name: 'office_convert', parameters: {} }] },
    commands: { register: (definition: { name: string; description: string; handler: (invocation: { agent: { id?: string }; rawInput: string }) => unknown }) => { commands.set(definition.name, definition); return () => commands.delete(definition.name); } },
    workingDirectory: { get: () => '/work' },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/work' }) },
    approval: { overrideOf: () => undefined, config: { policy: 'ask' }, request: async () => { calls.approvals++; return options.approval ?? 'allowed-once'; } },
    fs,
    web: { fetch: async (request: { url: string }) => ({ url: request.url, statusCode: 200, body: { kind: 'html', content: 'Example Domain' }, truncated: false }), search: async () => ({ sources: [{ url: 'https://example.org' }], truncated: false }) },
    on: (event: string, listener: (...args: never[]) => unknown) => { listeners.set(event, listener); return () => listeners.delete(event); },
    effect: (setup: () => () => void) => { void setup; },
    get: (key: string) => host[key],
    toolsMap: tools,
    commandsMap: commands,
    listeners,
    calls,
  };
  if (options.storage !== false) host.storageDomain = { open: async () => ({ table: () => table, close: async () => { await Promise.resolve(); } }) };
  const agent = { id: 'session-a', ctx: host, session: { header: {} } };
  return { host, agent, tools, commands, listeners, calls };
}
function execFor(agent: unknown, toolName: string) {
  return { agent, toolSet: {}, signal: new AbortController().signal, name: toolName, callId: 'call-1' };
}
async function ready(options: { approval?: string; storage?: boolean } = {}) {
  const f = makeHost(options);
  await apply(f.host as never);
  const check = f.tools.get('readiness_check');
  const probe = f.tools.get('readiness_probe');
  const remedy = f.tools.get('readiness_remedy');
  assert.ok(check && probe && remedy);
  return { ...f, check, probe, remedy };
}
test('the plugin advertises a stable name, injects only the tool registry and registers its surface', async () => {
  assert.equal(pluginName, 'task-readiness');
  assert.deepEqual([...inject], ['tools']);
  const f = await ready();
  assert.deepEqual([...f.tools.keys()].sort(), ['readiness_check', 'readiness_probe', 'readiness_remedy']);
  assert.deepEqual([...f.commands.keys()].sort(), ['readiness', 'readiness-list', 'readiness-refresh']);
  for (const definition of f.tools.values()) assert.ok(definition.description && definition.description.length > 10);
});
test('the plugin refuses to mount without a tool registry instead of silently doing nothing', async () => {
  const f = makeHost();
  delete f.host.tools;
  await assert.rejects(apply(f.host as never), { code: 'TOOL_REGISTRY_UNAVAILABLE' });
});
test('a step check reports readiness without running any probe', async () => {
  const f = await ready();
  const result = (await f.check.execute({ title: 'Synthetic', requirements: [{ id: 'r', capability: 'files.read' }], files: ['notes.txt'] }, execFor(f.agent, 'readiness_check'))) as Record<string, unknown>;
  assert.equal(result.status, 'ready_unverified');
  assert.equal(typeof result.id, 'string');
  assert.equal(f.calls.probes, 0);
  assert.equal(f.calls.approvals, 0);
  const options = result.probeOptions as Array<{ requirementId: string; probe: boolean }>;
  assert.deepEqual(options.map((option) => [option.requirementId, option.probe]), [['r', true]]);
});
test('a check without a step agent is refused rather than reported as unknown', async () => {
  const f = await ready();
  await assert.rejects(f.check.execute({ title: 'x', requirements: [{ id: 'r', capability: 'files.read' }] }, { signal: new AbortController().signal, name: 'readiness_check' }), { code: 'AGENT_REQUIRED' });
});
test('an invalid task intent fails closed instead of storing a permissive report', async () => {
  const f = await ready();
  await assert.rejects(f.check.execute({ title: 'x', requirements: [{ id: 'r', capability: 'shell.exec' }] }, execFor(f.agent, 'readiness_check')));
});
test('a probe plan is inert until the host approves the run', async () => {
  const f = await ready();
  const check = (await f.check.execute({ title: 'Synthetic', requirements: [{ id: 'r', capability: 'files.read' }], files: ['notes.txt'] }, execFor(f.agent, 'readiness_check'))) as Record<string, unknown>;
  const planned = (await f.probe.execute({ reportId: check.id, requirementId: 'r', mode: 'plan' }, execFor(f.agent, 'readiness_probe'))) as Record<string, unknown>;
  assert.equal(planned.status, 'planned');
  assert.equal(f.calls.probes, 0);
  assert.equal(f.calls.approvals, 0);
  const ran = (await f.probe.execute({ reportId: check.id, requirementId: 'r', mode: 'run' }, execFor(f.agent, 'readiness_probe'))) as Record<string, unknown>;
  assert.equal(ran.status, 'succeeded');
  assert.equal(f.calls.approvals, 1);
  const report = ran.report as Record<string, unknown>;
  assert.equal(report.status, 'verified');
});
test('a refused approval never executes the probe', async () => {
  const f = await ready({ approval: 'rejected' });
  const check = (await f.check.execute({ title: 'Synthetic', requirements: [{ id: 'r', capability: 'files.read' }], files: ['notes.txt'] }, execFor(f.agent, 'readiness_check'))) as Record<string, unknown>;
  await assert.rejects(f.probe.execute({ reportId: check.id, requirementId: 'r', mode: 'run' }, execFor(f.agent, 'readiness_probe')), { code: 'APPROVAL_DENIED' });
  assert.equal(f.calls.probes, 0);
  assert.equal(f.calls.approvals, 1);
});
test('a capability without a real probe is refused with an explanation instead of a fake test', async () => {
  const f = await ready();
  const check = (await f.check.execute({ title: 'Synthetic', requirements: [{ id: 'r', capability: 'image.inspect' }] }, execFor(f.agent, 'readiness_check'))) as Record<string, unknown>;
  await assert.rejects(f.probe.execute({ reportId: check.id, requirementId: 'r', mode: 'plan' }, execFor(f.agent, 'readiness_probe')), { code: 'PROBE_UNSUPPORTED' });
  const options = check.probeOptions as Array<{ probe: boolean; limitation: string }>;
  assert.equal(options.length, 1);
  assert.equal(options[0].probe, false);
  assert.match(options[0].limitation, /模型/);
});
test('a host without durable storage keeps diagnostics working and refuses every action', async () => {
  const f = await ready({ storage: false });
  const check = (await f.check.execute({ title: 'Synthetic', requirements: [{ id: 'r', capability: 'files.read' }], files: ['notes.txt'] }, execFor(f.agent, 'readiness_check'))) as Record<string, unknown>;
  assert.equal(typeof check.id, 'string');
  const ran = (await f.probe.execute({ reportId: check.id, requirementId: 'r', mode: 'run' }, execFor(f.agent, 'readiness_probe'))) as Record<string, unknown>;
  assert.equal(ran.status, 'failed');
  assert.equal(f.calls.probes, 0);
});
test('the write remedy changes only this plugin task option and can be restored', async () => {
  const f = await ready();
  const check = (await f.check.execute({ title: 'Synthetic', requirements: [{ id: 'out', capability: 'files.write' }], outputDirectory: '/work/out' }, execFor(f.agent, 'readiness_check'))) as Record<string, unknown>;
  const planned = (await f.remedy.execute({ reportId: check.id, actionId: 'set-output', value: '/work/other', expectedOptionsRevision: 0, mode: 'plan' }, execFor(f.agent, 'readiness_remedy'))) as Record<string, unknown>;
  assert.equal(planned.status, 'planned');
  const applied = (await f.remedy.execute({ reportId: check.id, actionId: 'set-output', value: '/work/other', expectedOptionsRevision: 0, mode: 'run' }, execFor(f.agent, 'readiness_remedy'))) as Record<string, unknown>;
  assert.equal(applied.status, 'succeeded');
  assert.equal(f.calls.approvals, 1);
  const receipt = applied.receipt as Record<string, unknown>;
  assert.equal(receipt.code, 'OPTIONS_UPDATED');
  assert.ok(applied.report, 'a re-check follows every executed remedy');
});
test('a model route change invalidates stored evidence instead of reusing it', async () => {
  const f = await ready();
  const check = (await f.check.execute({ title: 'Synthetic', requirements: [{ id: 'r', capability: 'files.read' }], files: ['notes.txt'] }, execFor(f.agent, 'readiness_check'))) as Record<string, unknown>;
  const listen = f.listeners.get('agent/pre-step');
  assert.ok(listen);
  const next = async () => ({ action: 'accept' });
  await listen({ agent: f.agent, turn: 1, step: 1, modelSelection: { provider: 'p', model: 'one' } } as never, next as never);
  await listen({ agent: f.agent, turn: 1, step: 2, modelSelection: { provider: 'p', model: 'two' } } as never, next as never);
  const listed = (await f.commands.get('readiness-list')!.handler({ agent: { id: 'session-a' }, rawInput: '' })) as { kind: string; text?: string };
  assert.equal(listed.kind, 'success');
  assert.match(listed.text ?? '', /过期/);
  assert.equal(typeof check.id, 'string');
});
test('slash commands stay read-only and point at the conversation for a precise recheck', async () => {
  const f = await ready();
  const help = (await f.commands.get('readiness')!.handler({ agent: { id: 'session-a' }, rawInput: '' })) as { kind: string; text?: string };
  assert.equal(help.kind, 'success');
  assert.match(help.text ?? '', /readiness_check/);
  assert.match(help.text ?? '', /没有本轮工具准入/);
  const refreshed = (await f.commands.get('readiness-refresh')!.handler({ agent: { id: 'session-a' }, rawInput: '' })) as { kind: string; text?: string };
  assert.match(refreshed.text ?? '', /失效/);
  assert.equal(f.calls.approvals, 0);
  assert.equal(f.calls.probes, 0);
});
test('the render projection explains the result without leaking session or paths', async () => {
  const f = await ready();
  const result = (await f.check.execute({ title: 'Synthetic', requirements: [{ id: 'r', capability: 'files.read' }], files: ['notes.txt'] }, execFor(f.agent, 'readiness_check'))) as Record<string, unknown>;
  const blocks = f.check.output.render({}, result);
  const text = blocks.map((block) => block.text ?? '').join('\n');
  assert.match(text, /任务就绪检查/);
  assert.match(text, /读取文件/);
  assert.ok(!text.includes('session-a'));
  assert.ok(!text.includes('/work'));
  assert.ok(!text.includes('notes.txt'));
});

test('a built-in template and an equivalent structured request reach the same diagnosis', async () => {
  const f = await ready();
  const templated = (await f.check.execute({ template: 'images', files: ['photo.png'] }, execFor(f.agent, 'readiness_check'))) as Record<string, unknown>;
  const structured = (await f.check.execute({ title: '读取图片', requirements: [{ id: 'step1', capability: 'files.read' }, { id: 'step2', capability: 'image.inspect' }], files: ['photo.png'] }, execFor(f.agent, 'readiness_check'))) as Record<string, unknown>;
  const shape = (report: Record<string, unknown>) => (report.checks as Array<Record<string, unknown>>).map((check) => [check.capability, check.status, check.availability, check.preconditions]);
  assert.deepEqual(shape(templated), shape(structured));
  assert.equal(templated.status, structured.status);
});
test('a check without requirements or a template is refused', async () => {
  const f = await ready();
  await assert.rejects(f.check.execute({ title: 'no requirements' }, execFor(f.agent, 'readiness_check')), { code: 'INVALID_INTENT' });
  await assert.rejects(f.check.execute({ template: 'shell-anything' }, execFor(f.agent, 'readiness_check')));
});

test('the pending card names the check and only follows real file inputs', async () => {
  const f = await ready();
  const call = f.check.presentCall!({ template: 'images', files: ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'] });
  assert.equal(call?.card, 'generic');
  assert.match(call?.title ?? '', /^功能体检：模板 images$/);
  assert.equal(call?.kind, 'read');
  assert.deepEqual(call?.locations?.map((location) => location.path), ['a.png', 'b.png', 'c.png', 'd.png']);
  const titled = f.check.presentCall!({ title: '联调检索', requirements: [{ id: 'r', capability: 'web.search' }] });
  assert.match(titled?.title ?? '', /联调检索/);
  assert.equal(titled?.locations, undefined);
  assert.match(f.probe.presentCall!({ reportId: 'x', requirementId: 'r', mode: 'plan' })?.title ?? '', /生成探测计划/);
  assert.match(f.remedy.presentCall!({ reportId: 'x', actionId: 'set-output', value: '/w', expectedOptionsRevision: 0 })?.title ?? '', /准备处理/);
});
test('the completed card renders the canonical record instead of the model text', async () => {
  const f = await ready();
  const result = (await f.check.execute({ title: 'Synthetic', requirements: [{ id: 'r', capability: 'files.read' }], files: ['notes.txt'] }, execFor(f.agent, 'readiness_check'))) as Record<string, unknown>;
  const args = { title: 'Synthetic', requirements: [{ id: 'r', capability: 'files.read' }], files: ['notes.txt'] };
  const meta = f.check.output.presentationMeta!(args, result);
  const view = f.check.presentResult!(args, { content: [{ type: 'text', text: 'raw model text' }], isError: false, meta });
  assert.equal(view?.card, 'generic');
  assert.match(view?.title ?? '', /具备已知条件，尚未测试/);
  const text = (view?.content ?? []).map((block) => block.text ?? '').join('\n');
  assert.match(text, /读取文件/);
  assert.ok(!text.includes('raw model text'));
  assert.ok(!text.includes('session-a'));
  assert.ok(!text.includes('notes.txt'));
  const empty = f.check.presentResult!(args, { content: [], isError: false });
  assert.equal(empty, undefined);
});
test('presentation metadata is a bounded projection without task text or paths', async () => {
  const f = await ready();
  const result = (await f.check.execute({ title: 'Synthetic confidential merger', requirements: [{ id: 'r', capability: 'files.read' }], files: ['/private/notes.txt'] }, execFor(f.agent, 'readiness_check'))) as Record<string, unknown>;
  const meta = f.check.output.presentationMeta!({ title: 'Synthetic confidential merger', requirements: [{ id: 'r', capability: 'files.read' }], files: ['/private/notes.txt'] }, result) as Record<string, unknown>;
  assert.equal(typeof meta.id, 'string');
  assert.equal(meta.status, 'ready_unverified');
  const checks = meta.checks as Array<Record<string, unknown>>;
  assert.deepEqual(checks.map((check) => [check.capability, check.label]), [['files.read', '读取文件']]);
  const serialized = JSON.stringify(meta);
  assert.ok(!serialized.includes('confidential'));
  assert.ok(!serialized.includes('/private'));
  assert.ok(!serialized.includes('session-a'));
});
test('an executed action card shows the receipt and the recheck status', async () => {
  const f = await ready();
  const check = (await f.check.execute({ title: 'Synthetic', requirements: [{ id: 'r', capability: 'files.read' }], files: ['notes.txt'] }, execFor(f.agent, 'readiness_check'))) as Record<string, unknown>;
  const ran = (await f.probe.execute({ reportId: check.id, requirementId: 'r', mode: 'run' }, execFor(f.agent, 'readiness_probe'))) as Record<string, unknown>;
  const args = { reportId: check.id, requirementId: 'r', mode: 'run' };
  const meta = f.probe.output.presentationMeta!(args, ran);
  const view = f.probe.presentResult!(args, { content: [], isError: false, meta });
  const text = (view?.content ?? []).map((block) => block.text ?? '').join('\n');
  assert.match(text, /动作状态：已成功/);
  assert.match(text, /回执：PROBE_PASSED/);
  assert.match(text, /复检：指定测试通过/);
});

test('model arguments can never grant approval, even when they look like a confirmation', async () => {
  const f = await ready({ approval: 'rejected' });
  const check = (await f.check.execute({ title: 'Synthetic', requirements: [{ id: 'r', capability: 'files.read' }], files: ['notes.txt'] }, execFor(f.agent, 'readiness_check'))) as Record<string, unknown>;
  await assert.rejects(f.probe.execute({ reportId: check.id, requirementId: 'r', mode: 'run', approved: true, confirmation: 'allowed-once', token: 'x' }, execFor(f.agent, 'readiness_probe')), { code: 'APPROVAL_DENIED' });
  assert.equal(f.calls.probes, 0);
  assert.equal(f.calls.approvals, 1);
});
test('the probe tool refuses to run from a forged plan id or foreign report', async () => {
  const f = await ready();
  const check = (await f.check.execute({ title: 'Synthetic', requirements: [{ id: 'r', capability: 'files.read' }], files: ['notes.txt'] }, execFor(f.agent, 'readiness_check'))) as Record<string, unknown>;
  await assert.rejects(f.probe.execute({ reportId: check.id, requirementId: 'missing', mode: 'run' }, execFor(f.agent, 'readiness_probe')), { code: 'INVALID_PLAN' });
  await assert.rejects(f.probe.execute({ reportId: check.id, requirementId: 'r', mode: 'cancel', planId: 'action-made-up' }, execFor(f.agent, 'readiness_probe')), { code: 'NOT_FOUND' });
  assert.equal(f.calls.probes, 0);
});
test('oversized or malformed task intents are rejected before any evidence work', async () => {
  const f = await ready();
  const many = Array.from({ length: 25 }, (_, index) => ({ id: 'r' + index, capability: 'files.read' }));
  await assert.rejects(f.check.execute({ title: 'too many', requirements: many }, execFor(f.agent, 'readiness_check')), { code: 'INVALID_INTENT' });
  await assert.rejects(f.check.execute({ title: 'x'.repeat(201), requirements: [{ id: 'r', capability: 'files.read' }] }, execFor(f.agent, 'readiness_check')), { code: 'INVALID_INTENT' });
  await assert.rejects(f.check.execute({ title: 'dup', requirements: [{ id: 'r', capability: 'files.read' }, { id: 'r', capability: 'files.write' }] }, execFor(f.agent, 'readiness_check')), { code: 'INVALID_INTENT' });
  await assert.rejects(f.check.execute({ title: 'bad', requirements: [{ id: 'r', capability: 'files.read', server: 'alpha' }] }, execFor(f.agent, 'readiness_check')), { code: 'INVALID_INTENT' });
  assert.equal(f.calls.probes, 0);
});
test('a remedy that would write outside the session boundary fails without changing the option', async () => {
  const f = await ready();
  const check = (await f.check.execute({ title: 'Synthetic', requirements: [{ id: 'out', capability: 'files.write' }], outputDirectory: '/work/out' }, execFor(f.agent, 'readiness_check'))) as Record<string, unknown>;
  const ran = (await f.remedy.execute({ reportId: check.id, actionId: 'set-output', value: '/outside', expectedOptionsRevision: 0, mode: 'run' }, execFor(f.agent, 'readiness_remedy'))) as Record<string, unknown>;
  assert.equal(ran.status, 'failed');
  const receipt = ran.receipt as Record<string, unknown>;
  assert.equal(receipt.code, 'NOT_SUPPORTED');
});
