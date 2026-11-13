/**
 * Plugin-level SDK probe: mounts the built plugin's own tool definitions in the
 * real tool registry code (prototype calls, synthetic registries) and validates
 * its schemas with the host's own JSON Schema subset checker.
 * No live Context, profile, server, network or file system target is used.
 * Usage: ELECTRON_RUN_AS_NODE=1 <Electron> plugin-mount-probe.mjs <SDK root> <plugin entry> <output json>
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [sdkRootArg, pluginArg, outArg] = process.argv.slice(2);
const sdkRoot = resolve(sdkRootArg);
const load = (path) => import(pathToFileURL(resolve(sdkRoot, path)).href);
const toolsModule = await load('dsh-tools/lib/index.js');
const ToolsService = toolsModule.default;
const { defineTool, assertSupportedJsonSchema, assertObjectJsonSchema, validateJsonSchemaValue } = toolsModule;
const results = [];
async function check(name, run) {
  try { const observation = await run(); results.push({ name, status: 'passed', observation }); }
  catch (error) { results.push({ name, status: 'failed', error: String(error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : error) }); }
}
const mod = await import(pathToFileURL(resolve(pluginArg)).href);
let seq = 0;
function makeHost() {
  const visible = new Map();
  const registrations = new Map();
  const handlers = new Map();
  const rows = new Map();
  const calls = { approvals: 0, probeReads: 0 };
  const registry = () => {
    const service = { view: () => ({ visible, registrations }) };
    /** The host's public methods call each other through `this`, so bind the real prototypes. */
    service.definitions = (scope, set) => ToolsService.prototype.definitions.call(service, scope, set);
    service.schemas = (scope, set) => ToolsService.prototype.schemas.call(service, scope, set);
    service.executable = (name, scope, set) => ToolsService.prototype.executable.call(service, name, scope, set);
    return service;
  };
  const host = {
    tools: {
      register(definition) {
        visible.set(definition.name, definition);
        registrations.set(definition.name, { definition });
        return () => { visible.delete(definition.name); registrations.delete(definition.name); };
      },
      schemas: (agent, set) => registry().schemas(agent, set),
    },
    commands: { register: () => () => {} },
    workingDirectory: { get: () => '/work' },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/work' }) },
    approval: { overrideOf: () => undefined, config: { policy: 'ask' }, request: async () => { calls.approvals += 1; return 'allowed-once'; } },
    fs: {
      resolve: async (path) => ({ displayPath: path.startsWith('/') ? path : '/work/' + path }),
      stat: async (target) => ({ type: (target.displayPath.split('/').pop() ?? '').includes('.') ? 'file' : 'directory', version: 'v1', size: 4 }),
      processPath: (target) => target.displayPath,
      contains: (parent, child) => child.displayPath === parent.displayPath || child.displayPath.startsWith(parent.displayPath + '/'),
      readByteRange: async (_target, range) => { if (range.length > 1) calls.probeReads += 1; return new Uint8Array(range.length).fill(65); },
      writeText: async (_target, content) => ({ operation: 'create', version: 'v1', before: null, after: content }),
      deleteFile: async () => ({ removed: true }),
    },
    web: { fetch: async (request) => ({ url: request.url, statusCode: 200, body: { kind: 'html', content: 'Example Domain' }, truncated: false }), search: async () => ({ sources: [{ url: 'https://example.org' }], truncated: false }), searchReady: async () => true, fetchReady: async () => true },
    storageDomain: { open: async () => ({ table: () => ({ get: (key) => rows.get(key), put: async (key, value) => { rows.set(key, value); }, delete: async (key) => rows.delete(key), entries: () => rows.entries(), get size() { return rows.size; } }), close: async () => {} }) },
    on: (event, listener) => { handlers.set(event, listener); return () => handlers.delete(event); },
    effect: () => {},
    get(key) { return host[key]; },
  };
  return { host, visible, registrations, handlers, calls, registry };
}
/** The step's admitted host tools, as a real session would expose them. */
function hostTools() {
  const names = ['read', 'write', 'read_image', 'web_search', 'web_fetch'];
  return names.map((name) => defineTool({ name, description: 'Synthetic host tool ' + name, parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: async () => 'synthetic' }));
}
async function mounted() {
  const f = makeHost();
  await mod.apply(f.host);
  for (const definition of hostTools()) {
    f.visible.set(definition.name, definition);
    f.registrations.set(definition.name, { definition });
  }
  const agent = { id: 'probe-session', session: {}, ctx: f.host, model: { current: () => ({ provider: 'probe', model: 'probe-model' }) } };
  const preStep = f.handlers.get('agent/pre-step');
  if (preStep) await preStep({ agent, turn: 1, step: 1, modelSelection: { provider: 'probe', model: 'probe-model' } }, async () => ({}));
  const service = f.registry();
  const set = await ToolsService.prototype.resolve.call(service, { agent, signal: new AbortController().signal, modelSelection: { provider: 'probe', model: 'probe-model' } });
  const exec = (name, args) => f.visible.get(name).execute(args, { agent, toolSet: set, signal: new AbortController().signal, name, callId: 'probe-call-' + (++seq) });
  return { ...f, agent, service, set, exec };
}
await check('apply registers the three readiness tools into a registry', async () => {
  const f = makeHost();
  await mod.apply(f.host);
  assert.deepEqual([...f.visible.keys()].filter((name) => name.startsWith('readiness_')).sort(), ['readiness_check', 'readiness_probe', 'readiness_remedy']);
  return 'Three readiness tools registered; no host package import was needed.';
});
await check('every definition schema stays inside the host JSON Schema subset', async () => {
  const f = await mounted();
  for (const name of ['readiness_check', 'readiness_probe', 'readiness_remedy']) {
    const definition = f.visible.get(name);
    assertSupportedJsonSchema(definition.parameters);
    assertObjectJsonSchema(definition.parameters);
    assertSupportedJsonSchema(definition.output.schema);
  }
  return 'Host assertSupportedJsonSchema/assertObjectJsonSchema accept all parameter and output schemas.';
});
await check('the host validator accepts valid arguments and rejects broken ones', async () => {
  const f = await mounted();
  const parameters = f.visible.get('readiness_check').parameters;
  assert.deepEqual(validateJsonSchemaValue(parameters, { title: 'x', requirements: [{ id: 'r', capability: 'files.read' }] }, ''), []);
  assert.notDeepEqual(validateJsonSchemaValue(parameters, { title: 'x', requirements: [{ id: 'r' }] }, ''), []);
  assert.notDeepEqual(validateJsonSchemaValue(parameters, { template: 'not-a-template' }, ''), []);
  assert.notDeepEqual(validateJsonSchemaValue(parameters, { title: 'x', requirements: [{ id: 'r', capability: 'shell.exec' }] }, ''), []);
  assert.notDeepEqual(validateJsonSchemaValue(parameters, { title: 'x', requirements: [{ id: 'r', capability: 'files.read', extra: 1 }] }, ''), []);
  const probe = f.visible.get('readiness_probe').parameters;
  assert.notDeepEqual(validateJsonSchemaValue(probe, { reportId: 'r' }, ''), [], 'missing requirementId must be reported');
  return 'Declared enums, required fields and closed nested objects all bind through the host validator.';
});
await check('the real registry admits the readiness tools in a resolved step', async () => {
  const f = await mounted();
  const admitted = [...f.set.view(f.agent).keys()];
  for (const name of ['readiness_check', 'readiness_probe', 'readiness_remedy']) assert.ok(admitted.includes(name), name + ' not admitted');
  assert.equal(f.service.executable('readiness_check', f.agent, f.set).name, 'readiness_check');
  const schemas = f.service.schemas(f.agent, f.set);
  const projected = schemas.find((schema) => schema.name === 'readiness_check');
  assert.ok(projected);
  assert.equal('execute' in projected, false);
  assert.equal('output' in projected, false);
  assert.equal(projected.parameters.properties.requirements.items.additionalProperties, false);
  f.set.dispose();
  assert.equal(f.set.view(f.agent).size, 0);
  return 'Admission, executable lookup and model-facing schema projection all work with the plugin definitions.';
});
await check('a step check reports step scope and only admitted capabilities', async () => {
  const f = await mounted();
  const report = await f.exec('readiness_check', { title: 'Synthetic', requirements: [{ id: 'r', capability: 'files.read' }], files: ['notes.txt'] });
  const check = report.checks[0];
  assert.equal(check.capability, 'files.read');
  assert.equal(check.availability, 'available');
  assert.equal(check.status, 'ready_unverified');
  assert.equal(f.calls.probeReads, 0);
  assert.deepEqual(validateJsonSchemaValue(f.visible.get('readiness_check').output.schema, report, ''), []);
  f.set.dispose();
  return 'Step-scoped admission drives availability; the check itself runs no probe.';
});
await check('without a step admission the same check cannot claim availability', async () => {
  const f = await mounted();
  const report = await f.visible.get('readiness_check').execute({ title: 'Synthetic', requirements: [{ id: 'r', capability: 'files.read' }], files: ['notes.txt'] }, { agent: f.agent, signal: new AbortController().signal, name: 'readiness_check' });
  assert.equal(report.checks[0].availability, 'unknown');
  assert.equal(report.checks[0].status, 'unknown');
  f.set.dispose();
  return 'No toolSet means registered-scope only, so the report stays unknown instead of optimistic.';
});
await check('a probe plan is inert and an approved probe verifies the capability', async () => {
  const f = await mounted();
  const report = await f.exec('readiness_check', { title: 'Synthetic', requirements: [{ id: 'r', capability: 'files.read' }], files: ['notes.txt'] });
  const planned = await f.exec('readiness_probe', { reportId: report.id, requirementId: 'r', mode: 'plan' });
  assert.equal(planned.status, 'planned');
  assert.equal(f.calls.probeReads, 0);
  assert.equal(f.calls.approvals, 0);
  const ran = await f.exec('readiness_probe', { reportId: report.id, requirementId: 'r', mode: 'run' });
  assert.equal(ran.status, 'succeeded');
  assert.equal(f.calls.approvals, 1);
  assert.equal(ran.report.status, 'verified');
  assert.deepEqual(validateJsonSchemaValue(f.visible.get('readiness_probe').output.schema, ran, ''), []);
  f.set.dispose();
  return 'Plan stays inert; run asks the host once and the recheck becomes verified.';
});
await check('an unsupported capability is refused at plan time with a host-valid error', async () => {
  const f = await mounted();
  const report = await f.exec('readiness_check', { title: 'Synthetic', requirements: [{ id: 'r', capability: 'image.inspect' }] });
  await assert.rejects(f.exec('readiness_probe', { reportId: report.id, requirementId: 'r', mode: 'plan' }), (error) => error.code === 'PROBE_UNSUPPORTED');
  assert.equal(f.calls.probeReads, 0);
  f.set.dispose();
  return 'Unsupported probes never reach the host as a failed capability.';
});
await check('the built plugin has no runtime import outside node builtins', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(resolve(pluginArg), 'utf8');
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]).filter((specifier) => !specifier.startsWith('node:'));
  assert.deepEqual(imports, []);
  return 'Installed artifact imports only node builtins, so profile peer resolution cannot break it.';
});
const report = { schema: 'dsh-readiness-plugin-probe/v1', sdkVersion: '0.2.2-rc.2', runtime: process.version, generatedAt: new Date().toISOString(), scope: 'The built plugin mounted through real registry methods and the real JSON Schema validator with synthetic fixtures; no live Context, server or profile.', passed: results.filter((item) => item.status === 'passed').length, failed: results.filter((item) => item.status === 'failed').length, results };
if (outArg) await writeFile(outArg, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.failed) process.exitCode = 1;
