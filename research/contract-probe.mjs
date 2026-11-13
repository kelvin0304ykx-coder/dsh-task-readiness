/**
 * Design-time contract probes only; not plugin implementation or live-host E2E.
 * Imports installed SDK methods into an independent process and supplies synthetic owners.
 * No live Context, config, credentials, Session store, network provider, or package install.
 * Usage: ELECTRON_RUN_AS_NODE=1 <Electron> --expose-internals contract-probe.mjs <SDK namespace directory>
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(process.argv[2]);
const { default: ToolsService, defineTool } = await import(pathToFileURL(resolve(root, 'dsh-tools/lib/index.js')).href);
const { default: WebRuntime } = await import(pathToFileURL(resolve(root, 'dsh-web/lib/index.js')).href);
const results = [];
async function check(name, run) {
  try { const observation = await run(); results.push({ name, status: 'passed', observation }); }
  catch (error) { results.push({ name, status: 'failed', error: String(error) }); }
}
const definition = (name) => defineTool({name, description: 'Synthetic inert tool', parameters: {}, output: {schema: {type:'string'}, render: (_args, value) => [{type:'text',text:value}]}, execute: async () => 'not invoked'});
function registry(entries) {
  const visible = new Map(entries.map(([name]) => [name,definition(name)]));
  const registrations = new Map(entries.map(([name, when]) => [name,{definition:visible.get(name),when}]));
  const service = {view:() => ({visible,registrations})};
  return {service,visible,registrations};
}
const context = (agent, signal = new AbortController().signal) => ({agent,signal,modelSelection:{provider:'synthetic',model:'synthetic'}});
await check('registered-is-not-admitted', async () => {
  const r=registry([['plain',undefined],['conditional',()=>false]]), agent={};
  assert.equal(ToolsService.prototype.get.call(r.service,'conditional',agent)?.name,'conditional');
  const set=await ToolsService.prototype.resolve.call(r.service,context(agent));
  assert.deepEqual([...set.view(agent).keys()],['plain']); set.dispose();
  return 'An inspected definition can exist while excluded from the current step.';
});
await check('conditional-unavailable-outside-step', async () => {
  const r=registry([['conditional',()=>true]]);
  assert.equal(ToolsService.prototype.executable.call(r.service,'conditional',{}),undefined);
  return 'No admission token means conditional registrations cannot be called.';
});
await check('resolved-set-is-agent-specific', async () => {
  const r=registry([['plain',undefined]]), agent={};
  const set=await ToolsService.prototype.resolve.call(r.service,context(agent));
  assert.equal(set.view({}).size,0);assert.equal(set.view(agent).size,1);set.dispose();
  return 'Another Agent identity sees no tools in this admission set.';
});
await check('unloaded-tool-does-not-return', async () => {
  const r=registry([['plain',undefined]]), agent={};
  const set=await ToolsService.prototype.resolve.call(r.service,context(agent));
  r.visible.delete('plain');r.registrations.delete('plain');assert.equal(set.view(agent).size,0);set.dispose();
  return 'Removal after capture invalidates the admitted tool.';
});
await check('replacement-invalidates-old-admission', async () => {
  const r=registry([['plain',undefined]]), agent={};
  const set=await ToolsService.prototype.resolve.call(r.service,context(agent));
  const replacement=definition('plain');r.visible.set('plain',replacement);r.registrations.set('plain',{definition:replacement});
  assert.equal(set.view(agent).size,0);set.dispose();
  return 'Same name with a different registration cannot reuse old admission.';
});
await check('disposed-set-is-empty', async () => {
  const r=registry([['plain',undefined]]), agent={};
  const set=await ToolsService.prototype.resolve.call(r.service,context(agent));set.dispose();assert.equal(set.view(agent).size,0);
  return 'Step-owned tool handles cannot be retained as live report data.';
});
await check('activation-error-is-not-normal-unavailability', async () => {
  const r=registry([['bad',()=>{throw new Error('synthetic activation failure');}]]);
  await assert.rejects(ToolsService.prototype.resolve.call(r.service,context({})),e=>e.code==='TOOL_ACTIVATION_FAILED'||e.name==='ToolActivationError');
  return 'A failing activation callback rejects resolution instead of returning an absent tool.';
});
await check('cancelled-resolution-publishes-no-result', async () => {
  const c=new AbortController();c.abort();const r=registry([['plain',undefined]]);
  await assert.rejects(ToolsService.prototype.resolve.call(r.service,context({},c.signal)),e=>e.name==='AbortError');
  return 'Cancellation remains cancellation, not a negative capability verdict.';
});
await check('schema-projection-excludes-executor', async () => {
  const d=definition('plain');const service={definitions:()=>[d]};
  const schemas=ToolsService.prototype.schemas.call(service,{});
  assert.equal('execute' in schemas[0],false);assert.equal('output' in schemas[0],false);
  assert.notEqual(schemas[0].parameters,d.parameters);
  return 'Public schema projection excludes executable callbacks and detaches parameter data.';
});
await check('search-ready-can-be-true-on-selection-failure', async () => {
  const service={selectSearchProvider:()=>{throw new Error('synthetic missing provider');}};
  assert.equal(await WebRuntime.prototype.searchReady.call(service,'synthetic'),true);
  return 'True must never be presented as successful provider selection or network connectivity.';
});
await check('search-ready-false-is-a-specific-preflight-result', async () => {
  let route;const service={selectSearchProvider:()=>({ready:p=>{route=p;return false;}})};
  assert.equal(await WebRuntime.prototype.searchReady.call(service,'synthetic'),false);assert.equal(route,'synthetic');
  return 'False records the selected provider refusing readiness for the named chat route.';
});
await check('provider-without-readiness-is-not-tested', async () => {
  assert.equal(await WebRuntime.prototype.searchReady.call({selectSearchProvider:()=>({})},'synthetic'),true);
  return 'Omitted readiness check defaults true but supplies no successful-test evidence.';
});
await check('fetch-non-success-status-is-a-normal-result', async () => {
  const result=await WebRuntime.prototype.fetch.call({selectFetchProvider:()=>({fetch:async()=>({url:'https://example.invalid',statusCode:404,body:{kind:'text',content:'synthetic'},truncated:false})})},{url:'https://example.invalid'});
  assert.equal(result.statusCode,404);
  return 'A resolved Promise alone does not prove a usable retrieved page.';
});
const { apply: applyOfficeTools } = await import(pathToFileURL(resolve(root, 'dsh-tool-office/lib/index.js')).href);
function officeFixture() {
  const handlers = new Map(), visible = new Map(), registrations = new Map();
  const ctx = {
    on(name, callback) { handlers.set(name, callback); return () => {}; },
    tools: { register(definition, options) { visible.set(definition.name, definition); registrations.set(definition.name, {definition,when:options.when}); return () => {}; } },
    get() { return undefined; }
  };
  applyOfficeTools(ctx, {activationSkills:['office'],maxImages:4,maxImagePixels:4000000,maxImageDimension:2000,maxImageBytes:10000000});
  return {handlers,visible,service:{view:()=>({visible,registrations})}};
}
await check('office-skill-activation-needs-next-step', async () => {
  const f=officeFixture(), agent={session:{requestHeader:()=>undefined}};
  const before=await ToolsService.prototype.resolve.call(f.service,context(agent));
  assert.equal(before.view(agent).size,0);
  f.handlers.get('tools/result')({agent,name:'skill',arguments:{name:'office'}},{isError:true});
  const failed=await ToolsService.prototype.resolve.call(f.service,context(agent));assert.equal(failed.view(agent).size,0);failed.dispose();
  f.handlers.get('tools/result')({agent,name:'skill',arguments:{name:'office'}},{isError:false});
  assert.equal(before.view(agent).size,0);
  const after=await ToolsService.prototype.resolve.call(f.service,context(agent));assert.equal(after.view(agent).size,3);
  before.dispose();after.dispose();return 'Successful skill load admits three Office tools only in a newly resolved step; a failed load admits none.';
});
await check('office-activation-does-not-leak-to-other-agent', async () => {
  const f=officeFixture(), a={session:{requestHeader:()=>undefined}}, b={session:{requestHeader:()=>undefined}};
  f.handlers.get('tools/result')({agent:a,name:'skill',arguments:{name:'office'}},{isError:false});
  const other=await ToolsService.prototype.resolve.call(f.service,context(b));assert.equal(other.view(b).size,0);other.dispose();
  return 'The successful activation of one synthetic Agent does not activate another.';
});
await check('office-admission-does-not-prove-engine-ready', async () => {
  const f=officeFixture(), agent={session:{requestHeader:()=>undefined}};
  f.handlers.get('tools/result')({agent,name:'skill',arguments:{name:'office'}},{isError:false});
  const set=await ToolsService.prototype.resolve.call(f.service,context(agent));assert.equal(set.view(agent).size,3);
  await assert.rejects(f.visible.get('office_convert').execute({input:'synthetic.docx',format:'pdf'},{agent,signal:new AbortController().signal}),/unavailable/i);
  set.dispose();return 'An admitted Office conversion still fails when the engine service is absent; no source file is read.';
});
const report={schema:'dsh-readiness-interface-probe/v1',sdkVersion:'0.2.2-rc.2',runtime:process.version,generatedAt:new Date().toISOString(),scope:'Actual installed method bodies with synthetic fixtures; no instantiated host or live services. Private selection-method stubs exist only inside this research probe, not a product API dependency.',passed:results.filter(x=>x.status==='passed').length,failed:results.filter(x=>x.status==='failed').length,results};
console.log(JSON.stringify(report,null,2));
if(report.failed)process.exitCode=1;
