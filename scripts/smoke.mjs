/**
 * Load the built package the way a host would and exercise its public surface
 * with a synthetic context. No DSH host, profile or network is involved.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const argument = process.argv[2];
/** A bare package name is resolved like an installed host would; anything else is a path. */
const byName = argument !== undefined && !argument.includes('/') && !argument.startsWith('.');
const entry = byName ? argument : resolve(argument ?? fileURLToPath(new URL('../lib/index.js', import.meta.url)));
const mod = await import(byName ? entry : pathToFileURL(entry).href);
const problems = [];
function check(condition, message) { if (!condition) problems.push(message); }
const tools = new Map();
const commands = new Map();
const listeners = new Map();
const calls = { approvals: 0, probes: 0 };
const rows = new Map();
const table = { get: (key) => rows.get(key), put: async (key, value) => { rows.set(key, value); }, delete: async (key) => rows.delete(key), entries: () => rows.entries(), get size() { return rows.size; } };
const host = {
  tools: {
    register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name); },
    schemas: () => [{ name: 'read', parameters: {} }, { name: 'write', parameters: {} }, { name: 'read_image', parameters: {} }, { name: 'web_search', parameters: {} }, { name: 'web_fetch', parameters: {} }, { name: 'office_convert', parameters: {} }],
  },
  commands: { register: (definition) => { commands.set(definition.name, definition); return () => commands.delete(definition.name); } },
  workingDirectory: { get: () => '/work' },
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/work' }) },
  approval: { overrideOf: () => undefined, config: { policy: 'ask' }, request: async () => { calls.approvals += 1; return 'allowed-once'; } },
  fs: {
    resolve: async (path) => ({ displayPath: path.startsWith('/') ? path : '/work/' + path }),
    stat: async (target) => ({ type: (target.displayPath.split('/').pop() ?? '').includes('.') ? 'file' : 'directory', version: 'v1', size: 4 }),
    processPath: (target) => target.displayPath,
    contains: (parent, child) => child.displayPath === parent.displayPath || child.displayPath.startsWith(parent.displayPath + '/'),
    readByteRange: async (_target, range) => { if (range.length > 1) calls.probes += 1; return new Uint8Array(range.length).fill(65); },
    writeText: async (_target, content) => { calls.probes += 1; return { operation: 'create', version: 'v1', before: null, after: content }; },
    deleteFile: async () => ({ removed: true }),
  },
  web: {
    fetch: async (request) => ({ url: request.url, statusCode: 200, body: { kind: 'html', content: 'Example Domain' }, truncated: false }),
    search: async () => ({ sources: [{ url: 'https://example.org' }], truncated: false }),
  },
  storageDomain: { open: async () => ({ table: () => table, close: async () => {} }) },
  on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
  effect: () => {},
  get(key) { return host[key]; },
};
const agent = { id: 'smoke-session', ctx: host, session: { header: {} } };
const exec = (name) => ({ agent, toolSet: {}, signal: new AbortController().signal, name, callId: 'smoke-call' });
check(mod.name === 'task-readiness', 'plugin name export changed');
check(Array.isArray(mod.inject) && mod.inject.includes('tools'), 'plugin inject must include tools');
check(typeof mod.apply === 'function', 'plugin must export apply');
await mod.apply(host);
check(tools.size === 3, 'expected three readiness tools, got ' + tools.size);
check(commands.size === 3, 'expected three readiness commands, got ' + commands.size);
const checkTool = tools.get('readiness_check');
const probeTool = tools.get('readiness_probe');
const report = await checkTool.execute({ title: 'Synthetic smoke', requirements: [{ id: 'r', capability: 'files.read' }], files: ['notes.txt'] }, exec('readiness_check'));
check(report.status === 'ready_unverified', 'unexpected report status ' + report.status);
check(Array.isArray(report.probeOptions) && report.probeOptions.length === 1, 'probe options missing');
check(calls.probes === 0, 'a check must not execute a probe');
const planned = await probeTool.execute({ reportId: report.id, requirementId: 'r', mode: 'plan' }, exec('readiness_probe'));
check(planned.status === 'planned' && calls.probes === 0, 'planning must stay inert');
const ran = await probeTool.execute({ reportId: report.id, requirementId: 'r', mode: 'run' }, exec('readiness_probe'));
check(ran.status === 'succeeded', 'approved probe did not succeed: ' + ran.status);
check(calls.approvals === 1, 'approval was not requested exactly once');
check(ran.report.status === 'verified', 'recheck did not become verified');
const rendered = checkTool.output.render({}, report).map((block) => block.text ?? '').join('\n');
check(rendered.includes('任务就绪检查'), 'render projection lost its heading');
check(!rendered.includes('smoke-session'), 'render projection leaks the session id');
await commands.get('readiness-refresh').handler({ agent: { id: 'smoke-session' }, rawInput: '' });
console.log(JSON.stringify({ ok: problems.length === 0, entry, plugin: mod.name, tools: [...tools.keys()], commands: [...commands.keys()], reportStatus: report.status, afterProbe: ran.report.status, approvals: calls.approvals, problems }, null, 2));
if (problems.length > 0) process.exitCode = 1;