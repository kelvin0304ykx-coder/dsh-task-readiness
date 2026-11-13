import { ActionStore, TaskOptionsStore } from '../core/actions.ts';
import type { ActionJournal, ActionPlan, ActionReceipt, ExecutionOutcome } from '../core/actions.ts';
import { diagnose, fingerprint } from '../core/diagnose.ts';
import { parseIntent } from '../core/intent.ts';
import { shareReport } from '../core/privacy.ts';
import { ReadinessError } from '../core/types.ts';
import type { ProbeEvidence, Report, SessionSnapshot, TaskIntent } from '../core/types.ts';
import type { CapturedStep, SnapshotAgent } from './snapshot.ts';
export interface CheckContext {agent:SnapshotAgent;signal:AbortSignal;toolSet?:unknown;capturedStep?:CapturedStep;toolName:string;callId?:string;token?:symbol}
interface Dependencies {
  capture(intent:TaskIntent,context:CheckContext,epoch:number):Promise<SessionSnapshot>;
  requestApproval(context:CheckContext,reason:string):Promise<string>;
  executeProbe(context:CheckContext,plan:ActionPlan,report:Report,signal:AbortSignal):Promise<ExecutionOutcome>;
  journal:ActionJournal;clock?:()=>number;maxReports?:number;
}
interface Stored {report:Report;baseIntent:TaskIntent;epoch:number}
export interface RunResult {receipt:ActionReceipt;report:Report;options:{revision:number;operationId?:string}}
function fail(code:string):never{throw new ReadinessError(code,code);}
function owner(id:string,principal:'user'|'agent'='agent'){if(typeof id!=='string'||!id||id.length>200)fail('AGENT_REQUIRED');return {sessionId:id,principal};}
/** Session data is bounded and private; only the host can provide an approval result. */
export class ReadinessService {
  private readonly deps:Dependencies;
  private readonly clock:()=>number;
  private readonly maxReports:number;
  private epoch=0;
  private readonly reports=new Map<string,Stored>();
  private readonly probes=new Map<string,ProbeEvidence>();
  private readonly runs=new Map<string,Promise<RunResult>>();
  private readonly actions:ActionStore;
  private readonly options=new TaskOptionsStore();
  private disposed=false;
  constructor(deps:Dependencies){this.deps=deps;this.clock=deps.clock??Date.now;this.maxReports=deps.maxReports??100;if(!Number.isInteger(this.maxReports)||this.maxReports<1||this.maxReports>500)fail('INVALID_STORE_CONFIG');this.actions=new ActionStore({journal:deps.journal,clock:this.clock,maxPlans:100});}
  get generation(){return this.epoch;}
  async check(context:CheckContext,input:unknown):Promise<Report>{
    this.live();owner(context.agent?.id);context.signal.throwIfAborted();const baseIntent=parseIntent(input);const intent=this.effectiveIntent(context.agent.id,baseIntent);
    const snapshot=await this.capture(context,intent);const facts=structuredClone(snapshot.facts);
    for(const req of intent.requirements){const key=req.server?req.capability+':'+req.server:req.capability;const probe=this.probes.get(this.probeKey(context.agent.id,baseIntent,req.id));const fact=facts[key];if(!probe||!fact)continue;fact.probe=structuredClone(probe);if(probe.status==='passed'&&probe.binding===snapshot.stamp&&fact.availability==='available'&&fact.preconditions==='unknown')fact.preconditions='satisfied';}
    const report=diagnose(intent,{...snapshot,facts},this.clock());
    this.reports.set(report.id,{report:structuredClone(report),baseIntent,epoch:this.epoch});
    while(this.reports.size>this.maxReports)this.reports.delete(this.reports.keys().next().value!);
    return structuredClone(report);
  }
  list(sessionId:string):Report[]{owner(sessionId);return [...this.reports.values()].filter(r=>r.report.sessionId===sessionId).map(r=>this.getReport(sessionId,r.report.id)).reverse();}
  getReport(sessionId:string,id:string):Report {
    const stored=this.stored(sessionId,id);const r=structuredClone(stored.report);
    if(stored.epoch!==this.epoch){r.status='stale';for(const c of r.checks){c.status='stale';c.freshness='stale';if(!c.reasonCodes.includes('EVIDENCE_STALE'))c.reasonCodes.push('EVIDENCE_STALE');}for(const route of r.routes)route.status='stale';}
    return r;
  }
  exportReport(sessionId:string,id:string){return shareReport(this.getReport(sessionId,id));}
  plan(sessionId:string,reportId:string,input:unknown):ActionPlan{this.live();return this.actions.plan(owner(sessionId),this.getReport(sessionId,reportId),input);}
  getPlan(sessionId:string,id:string){return this.actions.get(owner(sessionId),id);}
  async run(context:CheckContext,id:string):Promise<RunResult>{
    this.live();const sessionId=context.agent?.id;const p=this.actions.get(owner(sessionId),id);
    if(context.toolSet===undefined)fail('STEP_REQUIRED');
    if(p.status==='cancelled')fail('ACTION_CANCELLED');
    const existing=this.runs.get(id);if(existing)return structuredClone(await existing);
    const pending=this.execute(context,p);this.runs.set(id,pending);
    try{return structuredClone(await pending);}catch(error){this.runs.delete(id);throw error;}
  }
  cancel(sessionId:string,id:string){this.actions.cancel(owner(sessionId,'user'),id);}
  invalidate(){this.epoch++;}
  dispose(){this.disposed=true;this.actions.dispose();}
  async close(){this.dispose();await Promise.allSettled(this.runs.values());this.reports.clear();this.probes.clear();this.runs.clear();}
  private async execute(context:CheckContext,plan:ActionPlan):Promise<RunResult>{
    const sessionId=context.agent.id;const row=this.stored(sessionId,plan.reportId);const baseIntent=row.baseIntent;
    if(row.epoch!==this.epoch)fail('SNAPSHOT_CHANGED');
    let current=await this.capture(context,this.effectiveIntent(sessionId,baseIntent));
    if(current.stamp!==plan.binding)fail('SNAPSHOT_CHANGED');if(current.approval!=='ask')fail('HOST_APPROVAL_REQUIRED');
    const reason='DSH 功能体检测试／处理确认\n'+JSON.stringify({action:plan.request,effects:plan.effects,cost:plan.cost==='unknown'?'费用未知；至多执行此计划一次，不保证金额上限':'不新增模型费用',scope:'仅当前会话及本插件拥有的任务选项',expiresAt:plan.expiresAt})+'\n拒绝或取消不会执行；批准仅对上述计划生效。';
    const granted=await this.deps.requestApproval(context,reason);
    if(granted!=='allowed-once'){this.actions.cancel(owner(sessionId,'user'),plan.id);fail('APPROVAL_DENIED');}
    context.signal.throwIfAborted();current=await this.capture(context,this.effectiveIntent(sessionId,baseIntent));
    if(row.epoch!==this.epoch||current.stamp!==plan.binding)fail('SNAPSHOT_CHANGED');
    const user=owner(sessionId,'user');const permit=this.actions.confirm(user,plan.id,plan.digest,plan.revision,{acceptCost:true});
    let operationId:string|undefined;
    const receipt=await this.actions.execute(user,plan.id,permit,current,async(p,signal)=>{
      if(p.request.kind==='probe')return this.deps.executeProbe({...context,signal},p,row.report,signal);
      const action=p.request;
      if(action.actionId==='restore-options'){this.options.restore(user,action.value,action.expectedOptionsRevision);return {status:'succeeded',code:'OPTIONS_RESTORED'};}
      if(action.actionId==='set-output'){
        const proposed=parseIntent({...this.effectiveIntent(sessionId,baseIntent),outputDirectory:action.value});
        if(!proposed.requirements.some(r=>r.capability==='files.write'))return {status:'failed',code:'NOT_SUPPORTED'};
        const preview=await this.capture({...context,signal},proposed);
        if(preview.facts['files.write']?.preconditions!=='satisfied')return {status:'failed',code:'NOT_SUPPORTED'};
      }
      const patch=action.actionId==='set-output'?{outputDirectory:action.value}:{routeId:action.value};
      const changed=this.options.update(user,action.expectedOptionsRevision,patch);operationId=changed.operationId;
      const after=await this.capture({...context,signal},this.effectiveIntent(sessionId,baseIntent));
      if(action.actionId==='set-output'&&after.facts['files.write']?.preconditions!=='satisfied'){
        this.options.restore(user,changed.operationId,changed.revision);operationId=undefined;return {status:'failed',code:'PROBE_FAILED'};
      }
      return {status:'succeeded',code:'OPTIONS_UPDATED'};
    },context.signal);
    if(plan.request.kind==='probe'){
      const status=receipt.status==='succeeded'?'passed':receipt.status==='failed'?'failed':receipt.status;
      this.probes.set(this.probeKey(sessionId,baseIntent,plan.request.requirementId),{id:receipt.id,status,checkedAt:receipt.finishedAt,binding:receipt.binding,scope:plan.request.probeId});
      while(this.probes.size>500)this.probes.delete(this.probes.keys().next().value!);
    }
    const report=await this.check(context,baseIntent);return {receipt,report,options:{revision:this.options.read(user).revision,...operationId?{operationId}:{}}};
  }
  private stored(sessionId:string,id:string):Stored{owner(sessionId);const row=this.reports.get(id);if(!row||row.report.sessionId!==sessionId)fail('NOT_FOUND');return row;}
  private effectiveIntent(sessionId:string,base:TaskIntent):TaskIntent{const o=this.options.read(owner(sessionId));const selected=o.routeId?base.routes.filter(r=>r.id===o.routeId):base.routes;if(!selected.length)fail('TASK_ROUTE_CHANGED');return parseIntent({...base,...o.outputDirectory?{outputDirectory:o.outputDirectory}:{},routes:selected});}
  private async capture(context:CheckContext,intent:TaskIntent):Promise<SessionSnapshot>{
    const before=this.epoch;const s=await this.deps.capture(intent,context,before);context.signal.throwIfAborted();
    if(before!==this.epoch)fail('SNAPSHOT_CHANGED');if(s.sessionId!==context.agent.id||!s.stamp)fail('SNAPSHOT_INVALID');
    return {...s,stamp:fingerprint([s.stamp,before,this.options.read(owner(context.agent.id)).revision])};
  }
  private probeKey(id:string,intent:TaskIntent,requirementId:string){return fingerprint([id,intent,requirementId]);}
  private live(){if(this.disposed)fail('SERVICE_DISPOSED');}
}
