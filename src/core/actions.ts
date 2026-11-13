import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { boundedText, strictObject } from './intent.ts';
import { fingerprint, fresh } from './diagnose.ts';
import { ReadinessError } from './types.ts';
import type { Capability, Report, SessionSnapshot } from './types.ts';
export interface ActionOwner { sessionId:string; principal:'user'|'agent' }
export type OutcomeStatus='succeeded'|'failed'|'cancelled'|'outcome_unknown';
export type OutcomeCode='PROBE_PASSED'|'PROBE_FAILED'|'PROBE_CANCELLED'|'PROBE_UNSUPPORTED'|'OUTCOME_UNKNOWN'|'NOT_SUPPORTED'|'OPTIONS_UPDATED'|'OPTIONS_RESTORED'|'JOURNAL_FAILED';
export interface ExecutionOutcome {status:OutcomeStatus;code:OutcomeCode}
export interface ActionReceipt extends ExecutionOutcome {id:string;planId:string;finishedAt:string;binding:string}
export type ActionRequest={kind:'probe';probeId:Capability;requirementId:string}|{kind:'remedy';actionId:'set-output'|'choose-route'|'restore-options';value:string;expectedOptionsRevision:number};
export interface ActionPlan {id:string;revision:number;sessionId:string;reportId:string;reportRevision:number;binding:string;request:ActionRequest;digest:string;createdAt:string;expiresAt:string;status:'planned'|'confirmed'|'running'|OutcomeStatus;cost:'none'|'unknown';effects:string[];receipt?:ActionReceipt}
export interface ActionPermit {token:string}
export interface JournalEvent {type:'intent'|'result';planId:string;sessionId:string;at:string;action:ActionRequest['kind'];binding:string;status?:OutcomeStatus;code?:OutcomeCode}
export interface ActionJournal {record(event:JournalEvent):Promise<void>}
export type ProbeExecutor=(plan:ActionPlan,signal:AbortSignal)=>Promise<ExecutionOutcome>;
interface InternalPlan {plan:ActionPlan;permit?:string;pending?:Promise<ActionReceipt>;controller?:AbortController}
interface StoreOptions {clock?:()=>number;timeoutMs?:number;ttlMs?:number;maxPlans?:number;journal:ActionJournal}
const CATALOG:Record<Capability,{cost:'none'|'unknown';effects:string[]}>={
  'web.search':{cost:'unknown',effects:['external-read']},'web.fetch':{cost:'unknown',effects:['external-read']},
  'files.read':{cost:'none',effects:['local-read']},'files.write':{cost:'none',effects:['local-write']},
  'image.inspect':{cost:'unknown',effects:['model-call']},'office.create':{cost:'none',effects:['local-write','process']},
  'office.render':{cost:'none',effects:['local-read','process']},'office.convert':{cost:'none',effects:['local-write','process']},
  'office.recalculate':{cost:'none',effects:['local-write','process']},'browser.read':{cost:'none',effects:['browser-tab']},
  'mcp.list':{cost:'unknown',effects:['connection']},
};
function fail(code:string):never{throw new ReadinessError(code,code);}
function principal(owner:ActionOwner,user=false){if(!owner||typeof owner.sessionId!=='string'||!owner.sessionId||!['user','agent'].includes(owner.principal))fail('NOT_FOUND');if(user&&owner.principal!=='user')fail('USER_CONFIRMATION_REQUIRED');}
function request(input:unknown,report:Report):ActionRequest {
  try {
    if(!input||typeof input!=='object')fail('INVALID_PLAN');
    const kind=(input as {kind?:unknown}).kind;
    if(kind==='probe'){
      const r=strictObject(input,['kind','probeId','requirementId']);
      if(typeof r.probeId!=='string'||!Object.hasOwn(CATALOG,r.probeId)||typeof r.requirementId!=='string')fail('INVALID_PLAN');
      const req=report.intent.requirements.find(x=>x.id===r.requirementId);
      if(!req||req.capability!==r.probeId)fail('INVALID_PLAN');
      return {kind,probeId:r.probeId as Capability,requirementId:r.requirementId};
    }
    if(kind==='remedy'){
      const r=strictObject(input,['kind','actionId','value','expectedOptionsRevision']);
      if(!['set-output','choose-route','restore-options'].includes(String(r.actionId))||!Number.isSafeInteger(r.expectedOptionsRevision)||Number(r.expectedOptionsRevision)<0)fail('INVALID_PLAN');
      const value=boundedText(r.value,r.actionId==='set-output'?4096:100,'remedy value');
      if(r.actionId==='choose-route'&&!report.intent.routes.some(x=>x.id===value))fail('INVALID_PLAN');
      return {kind,actionId:r.actionId as 'set-output'|'choose-route'|'restore-options',value,expectedOptionsRevision:r.expectedOptionsRevision as number};
    }
    fail('INVALID_PLAN');
  }catch{fail('INVALID_PLAN');}
}
function validOutcome(value:unknown):value is ExecutionOutcome {
  if(!value||typeof value!=='object')return false;
  const v=value as Record<string,unknown>;
  if(Object.keys(v).some(k=>!['status','code'].includes(k)))return false;
  const allowed:Record<OutcomeStatus,string[]>={succeeded:['PROBE_PASSED','OPTIONS_UPDATED','OPTIONS_RESTORED'],failed:['PROBE_FAILED','NOT_SUPPORTED'],cancelled:['PROBE_CANCELLED'],outcome_unknown:['OUTCOME_UNKNOWN','PROBE_UNSUPPORTED']};
  return Object.hasOwn(allowed,String(v.status))&&allowed[v.status as OutcomeStatus].includes(String(v.code));
}
export class ActionStore {
  private readonly clock:()=>number;
  private readonly timeoutMs:number;
  private readonly ttlMs:number;
  private readonly maxPlans:number;
  private readonly journal:ActionJournal;
  private readonly rows=new Map<string,InternalPlan>();
  constructor(options:StoreOptions){this.clock=options.clock??Date.now;this.timeoutMs=options.timeoutMs??10000;this.ttlMs=options.ttlMs??300000;this.maxPlans=options.maxPlans??100;this.journal=options.journal;if(!this.journal||!Number.isFinite(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>60000||!Number.isFinite(this.ttlMs)||this.ttlMs<1||this.ttlMs>300000||!Number.isInteger(this.maxPlans)||this.maxPlans<1||this.maxPlans>1000)fail('INVALID_STORE_CONFIG');}
  plan(owner:ActionOwner,report:Report,input:unknown):ActionPlan {
    principal(owner);if(report.sessionId!==owner.sessionId)fail('NOT_FOUND');
    if(!fresh(report.generatedAt,this.clock())||report.status==='stale')fail('SNAPSHOT_CHANGED');
    this.prune();if(this.rows.size>=this.maxPlans)fail('PLAN_CAPACITY');
    const parsed=request(input,report);const limits=parsed.kind==='probe'?CATALOG[parsed.probeId]:{cost:'none' as const,effects:['plugin-task-options']};
    const now=this.clock();const plan:ActionPlan={id:'action-'+randomUUID(),revision:1,sessionId:owner.sessionId,reportId:report.id,reportRevision:report.revision,binding:report.binding,request:parsed,digest:'',createdAt:new Date(now).toISOString(),expiresAt:new Date(now+this.ttlMs).toISOString(),status:'planned',cost:limits.cost,effects:[...limits.effects]};
    plan.digest=fingerprint([plan.id,plan.sessionId,plan.reportId,plan.reportRevision,plan.binding,plan.request,plan.expiresAt,plan.cost,plan.effects]);
    this.rows.set(plan.id,{plan});return structuredClone(plan);
  }
  get(owner:ActionOwner,id:string):ActionPlan{return structuredClone(this.row(owner,id).plan);}
  confirm(owner:ActionOwner,id:string,digest:string,revision:number,consent:{acceptCost:boolean}):ActionPermit {
    principal(owner,true);const row=this.row(owner,id);this.unexpired(row.plan);
    if(row.plan.digest!==digest||row.plan.revision!==revision)fail('PLAN_CHANGED');
    if(!['planned','confirmed'].includes(row.plan.status))fail('PLAN_SETTLED');
    if(row.plan.cost==='unknown'&&consent?.acceptCost!==true)fail('COST_CONSENT_REQUIRED');
    row.permit??=randomBytes(32).toString('hex');row.plan.status='confirmed';return {token:row.permit};
  }
  async execute(owner:ActionOwner,id:string,permit:ActionPermit,snapshot:SessionSnapshot,executor:ProbeExecutor,signal?:AbortSignal):Promise<ActionReceipt>{
    principal(owner,true);const row=this.row(owner,id);this.unexpired(row.plan);
    if(!this.matchesPermit(row,permit))fail('INVALID_PERMIT');
    if(snapshot.sessionId!==owner.sessionId||snapshot.stamp!==row.plan.binding||!fresh(snapshot.observedAt,this.clock()))fail('SNAPSHOT_CHANGED');
    if(snapshot.approval!=='ask')fail('HOST_APPROVAL_REQUIRED');
    if(row.plan.receipt)return structuredClone(row.plan.receipt);
    if(row.pending)return structuredClone(await row.pending);
    if(row.plan.status==='cancelled'||signal?.aborted){const receipt=this.receipt(row.plan,{status:'cancelled',code:'PROBE_CANCELLED'});row.plan.receipt=receipt;return structuredClone(receipt);}
    if(row.plan.status!=='confirmed')fail('INVALID_PERMIT');
    row.plan.status='running';row.controller=new AbortController();
    const pending=this.run(row,executor,signal);row.pending=pending;
    return structuredClone(await pending);
  }
  cancel(owner:ActionOwner,id:string):void {
    principal(owner,true);const row=this.row(owner,id);if(row.plan.receipt)return;
    if(row.plan.status==='running')row.controller?.abort();else row.plan.status='cancelled';
  }
  dispose():void{for(const row of this.rows.values()){if(row.plan.status==='running')row.controller?.abort();else if(!row.plan.receipt)row.plan.status='cancelled';}}
  private async run(row:InternalPlan,executor:ProbeExecutor,signal?:AbortSignal):Promise<ActionReceipt>{
    const p=row.plan,c=row.controller!;const propagate=()=>c.abort();signal?.addEventListener('abort',propagate,{once:true});if(signal?.aborted)c.abort();
    let timer:ReturnType<typeof setTimeout>|undefined;
    let outcome:ExecutionOutcome;
    try {
      try{await this.journal.record({type:'intent',planId:p.id,sessionId:p.sessionId,at:new Date(this.clock()).toISOString(),action:p.request.kind,binding:p.binding});}
      catch{return this.settle(row,{status:'failed',code:'JOURNAL_FAILED'});}
      if(c.signal.aborted)return this.settle(row,{status:'cancelled',code:'PROBE_CANCELLED'});
      const aborted=new Promise<ExecutionOutcome>(resolve=>{c.signal.addEventListener('abort',()=>resolve({status:'outcome_unknown',code:'OUTCOME_UNKNOWN'}),{once:true});});
      timer=setTimeout(()=>c.abort(),this.timeoutMs);
      const work=Promise.resolve().then(async()=>{
        if(c.signal.aborted)return {status:'cancelled',code:'PROBE_CANCELLED'} as ExecutionOutcome;
        try{const result=await executor(structuredClone(p),c.signal);return validOutcome(result)?result:{status:'outcome_unknown',code:'OUTCOME_UNKNOWN'} as ExecutionOutcome;}
        catch{return {status:'outcome_unknown',code:'OUTCOME_UNKNOWN'} as ExecutionOutcome;}
      });
      outcome=await Promise.race([work,aborted]);
      if(c.signal.aborted){await work;outcome={status:'outcome_unknown',code:'OUTCOME_UNKNOWN'};}
      try{await this.journal.record({type:'result',planId:p.id,sessionId:p.sessionId,at:new Date(this.clock()).toISOString(),action:p.request.kind,binding:p.binding,status:outcome.status,code:outcome.code});}
      catch{outcome={status:'outcome_unknown',code:'JOURNAL_FAILED'};}
      return this.settle(row,outcome);
    }finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',propagate);}
  }
  private settle(row:InternalPlan,outcome:ExecutionOutcome):ActionReceipt{const receipt=this.receipt(row.plan,outcome);row.plan.status=outcome.status;row.plan.receipt=receipt;return receipt;}
  private receipt(plan:ActionPlan,outcome:ExecutionOutcome):ActionReceipt{return {...outcome,id:'receipt-'+randomUUID(),planId:plan.id,binding:plan.binding,finishedAt:new Date(this.clock()).toISOString()};}
  private row(owner:ActionOwner,id:string):InternalPlan{principal(owner);const row=this.rows.get(id);if(!row||row.plan.sessionId!==owner.sessionId)fail('NOT_FOUND');return row;}
  private unexpired(plan:ActionPlan){if(this.clock()>=Date.parse(plan.expiresAt))fail('PLAN_EXPIRED');}
  private matchesPermit(row:InternalPlan,permit:ActionPermit):boolean{if(!row.permit||typeof permit?.token!=='string'||!/^[a-f0-9]{64}$/.test(permit.token)||permit.token.length!==row.permit.length)return false;return timingSafeEqual(Buffer.from(row.permit),Buffer.from(permit.token));}
  private prune(){for(const [id,row]of this.rows){if(row.plan.status!=='running'&&this.clock()>Date.parse(row.plan.expiresAt)+300000)this.rows.delete(id);}}
}
export interface TaskOptions {revision:number;outputDirectory?:string;routeId?:string}
export class TaskOptionsStore {
  private readonly rows=new Map<string,TaskOptions>();
  private readonly history=new Map<string,{owner:string;before:TaskOptions;afterRevision:number}>();
  read(owner:ActionOwner):TaskOptions{principal(owner);return structuredClone(this.rows.get(owner.sessionId)??{revision:0});}
  update(owner:ActionOwner,expected:number,input:unknown):TaskOptions&{operationId:string}{
    principal(owner,true);const patch=strictObject(input,['outputDirectory','routeId']);
    if(Object.keys(patch).length===0)fail('INVALID_INTENT');
    const before=this.read(owner);if(before.revision!==expected)fail('OPTIONS_CHANGED');
    const after:TaskOptions={...before,revision:before.revision+1};
    if(patch.outputDirectory!==undefined)after.outputDirectory=boundedText(patch.outputDirectory,4096,'output directory');
    if(patch.routeId!==undefined)after.routeId=boundedText(patch.routeId,64,'route');
    const operationId='options-'+randomUUID();this.rows.set(owner.sessionId,after);this.history.set(operationId,{owner:owner.sessionId,before,afterRevision:after.revision});
    // Only the most recent restore point per Session is needed for a safe CAS reversal.
    for(const [id,row]of this.history)if(id!==operationId&&row.owner===owner.sessionId)this.history.delete(id);
    return {...structuredClone(after),operationId};
  }
  restore(owner:ActionOwner,operationId:string,expected:number):TaskOptions{
    principal(owner,true);const current=this.read(owner);if(current.revision!==expected)fail('OPTIONS_CHANGED');
    const h=this.history.get(operationId);if(!h||h.owner!==owner.sessionId)fail('NOT_FOUND');if(h.afterRevision!==expected)fail('OPTIONS_CHANGED');
    const restored={...h.before,revision:current.revision+1};this.rows.set(owner.sessionId,restored);this.history.delete(operationId);return structuredClone(restored);
  }
  clear(owner:ActionOwner):void{principal(owner);this.rows.delete(owner.sessionId);for(const[id,row]of this.history)if(row.owner===owner.sessionId)this.history.delete(id);}
}
