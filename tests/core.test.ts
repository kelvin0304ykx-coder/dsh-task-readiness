import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent, templateIntent, handoffPrompt } from '../src/core/intent.ts';
import { diagnose } from '../src/core/diagnose.ts';
import { shareReport } from '../src/core/privacy.ts';
const now=Date.parse('2026-11-13T05:00:00Z');
const at=new Date(now).toISOString();
const intent=(capability='web.search')=>({version:1,title:'Test task',requirements:[{id:'one',capability}],files:[]});
function snapshot(facts={}) {return {sessionId:'session-a',stamp:'state-a',observedAt:at,scope:'step',route:{provider:'local-provider',model:'test-model'},cwd:'/Users/private/work',sandbox:'workspace-write',approval:'ask',facts};}
const fact=(changes={})=>({availability:'available',preconditions:'satisfied',reasonCodes:['BACKEND_NOT_TESTED'],evidence:[{kind:'declaration',code:'TOOL_ADMITTED',observedAt:at}],...changes});
// Removing strict validation would accept model-injected actions or ambiguous work.
test('intent rejects unknown capability and unknown keys',()=>{
  assert.throws(()=>parseIntent(intent('run_any_shell')));
  assert.throws(()=>parseIntent({...intent(),approved:true}));
  assert.throws(()=>parseIntent({...intent(),requirements:[{id:'one',capability:'web.search',script:'rm -rf /'}]}));
});
test('intent enforces node count, unique ids and known route references',()=>{
  const requirements=Array.from({length:25},(_,i)=>({id:'n'+i,capability:'web.search'}));
  assert.throws(()=>parseIntent({...intent(),requirements}));
  assert.throws(()=>parseIntent({...intent(),requirements:[{id:'same',capability:'web.search'},{id:'same',capability:'web.fetch'}]}));
  assert.throws(()=>parseIntent({...intent(),routes:[{id:'a',requires:['missing']}]}));
  assert.throws(()=>parseIntent({...intent(),routes:[{id:'a',requires:[]}]}));
});
test('intent rejects unsafe shape, oversized text, empty work and NUL paths',()=>{
  assert.throws(()=>parseIntent(null));
  assert.throws(()=>parseIntent({...intent(),requirements:[]}));
  assert.throws(()=>parseIntent({...intent(),title:'x'.repeat(201)}));
  assert.throws(()=>parseIntent({...intent(),files:['bad\u0000path']}));
  assert.throws(()=>parseIntent({...intent(),routes:[]}));
  assert.throws(()=>parseIntent(Object.assign(Object.create({inherited:true}),intent())));
});
test('a simple task gets an explicit all-required route and detached input',()=>{
  const input=intent(); const parsed=parseIntent(input);
  assert.deepEqual(parsed.routes,[{id:'primary',requires:['one']}]);
  input.requirements[0].id='changed';assert.equal(parsed.requirements[0].id,'one');
});
test('templates cover ordinary work without silently adding paid work',()=>{
  for(const id of ['research','documents','images','browser','mcp']){
    const task=templateIntent(id);assert.ok(task.requirements.length>0);assert.ok(task.requirements.length<=24);assert.equal(task.version,1);
  }
  assert.throws(()=>templateIntent('secret-template'));
  const task=templateIntent('research');assert.ok(task.requirements.some(x=>x.capability==='web.search'));
});
test('natural language handoff is an explicit check request, not an executor',()=>{
  const p=handoffPrompt('读取 PDF 并制作 PPT','zh');
  assert.ok(p.includes('读取 PDF 并制作 PPT'));assert.ok(p.includes('readiness_check'));
  assert.ok(p.includes('不要执行'));assert.throws(()=>handoffPrompt('','zh'));
  assert.throws(()=>handoffPrompt('x'.repeat(6001),'en'));
});
// The following tests catch false greens rather than implementation details.
test('missing evidence stays unknown',()=>{
  const r=diagnose(parseIntent(intent()),snapshot(),now);
  assert.equal(r.status,'unknown');assert.equal(r.checks[0].verification,'not_run');
});
test('ready preflight never implies a passed probe',()=>{
  const r=diagnose(parseIntent(intent()),snapshot({'web.search':fact()}),now);
  assert.equal(r.status,'ready_unverified');assert.equal(r.checks[0].verification,'not_run');
});
test('absent tool blocks only that route with known evidence',()=>{
  const r=diagnose(parseIntent(intent()),snapshot({'web.search':fact({availability:'absent',preconditions:'unmet',reasonCodes:['TOOL_NOT_VISIBLE']})}),now);
  assert.equal(r.status,'blocked');assert.equal(r.checks[0].availability,'absent');
});
test('registered-only observations cannot claim current-step availability',()=>{
  const r=diagnose(parseIntent(intent()),{...snapshot({'web.search':fact()}),scope:'registered'},now);
  assert.equal(r.status,'unknown');assert.equal(r.checks[0].availability,'unknown');
});
test('Office preparation is explicit rather than a reinstall diagnosis',()=>{
  const r=diagnose(parseIntent(intent('office.render')),snapshot({'office.render':fact({availability:'absent',preconditions:'unmet',reasonCodes:['SKILL_REQUIRED']})}),now);
  assert.equal(r.status,'blocked');assert.ok(r.checks[0].nextSteps.some(x=>x.id==='load-office-skill'));
});
test('AND dependencies block incomplete routes while a complete alternative is usable',()=>{
  const task=parseIntent({version:1,title:'Research',files:[],requirements:[{id:'search',capability:'web.search'},{id:'fetch',capability:'web.fetch'},{id:'browser',capability:'browser.read'}],routes:[{id:'search-route',requires:['search','fetch']},{id:'browser-route',requires:['browser']}]});
  const snap=snapshot({'web.search':fact(),'web.fetch':fact({availability:'absent',preconditions:'unmet'}),'browser.read':fact()});
  const r=diagnose(task,snap,now);
  assert.equal(r.routes[0].status,'blocked');assert.equal(r.routes[1].status,'ready_unverified');assert.equal(r.status,'ready_unverified');
});
test('one unknown alternative prevents claiming the whole task impossible',()=>{
  const task=parseIntent({...intent(),requirements:[{id:'a',capability:'web.search'},{id:'b',capability:'browser.read'}],routes:[{id:'a',requires:['a']},{id:'b',requires:['b']}]});
  const r=diagnose(task,snapshot({'web.search':fact({availability:'absent',preconditions:'unmet'})}),now);assert.equal(r.status,'unknown');
});
test('a valid bound probe can verify its exact capability',()=>{
  const r=diagnose(parseIntent(intent()),snapshot({'web.search':fact({probe:{status:'passed',checkedAt:at,binding:'state-a',scope:'synthetic-search',id:'p1'}})}),now);
  assert.equal(r.status,'verified');assert.equal(r.checks[0].verification,'passed');
});
test('a passed old-route probe is stale, not reusable',()=>{
  const r=diagnose(parseIntent(intent()),snapshot({'web.search':fact({probe:{status:'passed',checkedAt:at,binding:'old-route',scope:'synthetic-search',id:'p1'}})}),now);
  assert.equal(r.status,'stale');assert.equal(r.checks[0].freshness,'stale');
});
test('old and future-dated observations never produce current green',()=>{
  for(const t of [now-300001,now+10000]){
    const r=diagnose(parseIntent(intent()),{...snapshot({'web.search':fact()}),observedAt:new Date(t).toISOString()},now);assert.equal(r.status,'stale');
  }
});
test('cancelled or uncertain probes are not reported as broken capabilities',()=>{
  for(const status of ['cancelled','outcome_unknown']){
    const r=diagnose(parseIntent(intent()),snapshot({'web.search':fact({probe:{status,checkedAt:at,binding:'state-a',scope:'synthetic-search',id:'p1'}})}),now);
    assert.notEqual(r.status,'blocked');assert.notEqual(r.status,'verified');assert.equal(r.checks[0].verification,status);
  }
});
test('a failed current probe does not report ready',()=>{
  const r=diagnose(parseIntent(intent()),snapshot({'web.search':fact({probe:{status:'failed',checkedAt:at,binding:'state-a',scope:'synthetic-search',id:'p1'}})}),now);assert.equal(r.status,'blocked');
});
test('probe success cannot override a newly known unmet precondition',()=>{
  const r=diagnose(parseIntent(intent()),snapshot({'web.search':fact({preconditions:'unmet',reasonCodes:['READINESS_REFUSED'],probe:{status:'passed',checkedAt:at,binding:'state-a',scope:'synthetic-search',id:'p1'}})}),now);assert.equal(r.status,'blocked');
});
test('share export excludes raw task, identities, paths, arbitrary evidence and upstream text',()=>{
  const task=parseIntent({...intent(),title:'Client Secret person@example.invalid',files:['/Users/private/client.docx']});
  const r=diagnose(task,snapshot({'web.search':fact({evidence:[{kind:'preflight',code:'BACKEND_NOT_TESTED',observedAt:at,details:{token:'secret-test-token',path:'/Users/private/',host:'private.corp'}}]})}),now);
  const text=JSON.stringify(shareReport(r));
  for(const s of ['Client Secret','person@example.invalid','session-a','local-provider','test-model','/Users/private','secret-test-token','private.corp'])assert.ok(!text.includes(s),s);
  assert.ok(text.includes('web.search'));assert.ok(text.includes('ready_unverified'));
});
