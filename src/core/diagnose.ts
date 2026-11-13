import { createHash } from 'node:crypto';
import { parseIntent } from './intent.ts';
import { LABELS, STATUS_LABELS, knownReason, nextSteps } from './messages.ts';
import type { CapabilityResult, Evidence, Report, SessionSnapshot, Status, TaskIntent } from './types.ts';
export function fingerprint(value:unknown):string{return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export function fresh(at:string,now:number):boolean{const t=Date.parse(at);return Number.isFinite(t)&&t<=now+5000&&now-t<=300000;}
function conjunction(items:Status[]):Status{
  if(items.includes('blocked'))return 'blocked';
  if(items.includes('stale'))return 'stale';
  if(items.includes('unknown'))return 'unknown';
  return items.every(s=>s==='verified')?'verified':'ready_unverified';
}
function alternatives(items:Status[]):Status{
  if(items.includes('verified'))return 'verified';
  if(items.includes('ready_unverified'))return 'ready_unverified';
  if(items.includes('unknown'))return 'unknown';
  if(items.includes('stale'))return 'stale';
  return 'blocked';
}
export function diagnose(rawIntent:TaskIntent,snapshot:SessionSnapshot,now=Date.now()):Report {
  const intent=parseIntent(rawIntent);
  const checks:CapabilityResult[]=intent.requirements.map(req=>{
    const fact=snapshot.facts[req.server?req.capability+':'+req.server:req.capability];
    const availability=snapshot.scope==='step'?(fact?.availability??'unknown'):'unknown';
    const preconditions=fact?.preconditions??'unknown';
    const probe=fact?.probe;
    const stale=!fresh(snapshot.observedAt,now)||(probe!==undefined&&(probe.binding!==snapshot.stamp||!fresh(probe.checkedAt,now)));
    const verification=probe?.status??'not_run';
    const reasonCodes=[...new Set((fact?.reasonCodes??['CAPABILITY_UNKNOWN']).map(knownReason))];
    if(snapshot.scope!=='step')reasonCodes.push('NO_STEP_ADMISSION');
    if(stale)reasonCodes.push('EVIDENCE_STALE');
    let status:Status;
    if(!fresh(snapshot.observedAt,now))status='stale';
    else if(availability==='absent'||preconditions==='unmet')status='blocked';
    else if(stale)status='stale';
    else if(availability==='unknown'||preconditions==='unknown')status='unknown';
    else if(verification==='failed')status='blocked';
    else if(verification==='passed')status='verified';
    else status='ready_unverified';
    if(probe)reasonCodes.push(({passed:'PROBE_PASSED',failed:'PROBE_FAILED',cancelled:'PROBE_CANCELLED',outcome_unknown:'PROBE_OUTCOME_UNKNOWN'} as const)[probe.status]);
    const evidence:Evidence[]=(fact?.evidence??[]).slice(0,12).map(e=>({kind:e.kind,code:knownReason(e.code),observedAt:Number.isFinite(Date.parse(e.observedAt))?e.observedAt:snapshot.observedAt}));
    return {id:req.id,capability:req.capability,label:LABELS[req.capability],status,availability,preconditions,verification,freshness:stale?'stale':'current',reasonCodes:[...new Set(reasonCodes)],summary:STATUS_LABELS[status],nextSteps:nextSteps(reasonCodes,req.capability),evidence,...probe?{probe:{id:probe.id,status:probe.status,checkedAt:probe.checkedAt,binding:probe.binding,scope:probe.scope}}:{}};
  });
  const byId=new Map(checks.map(c=>[c.id,c]));
  const routes=intent.routes.map(r=>({...r,status:conjunction(r.requires.map(id=>byId.get(id)!.status))}));
  return {version:1,id:'report-'+fingerprint([snapshot.sessionId,intent,snapshot.stamp,now]).slice(0,24),revision:1,sessionId:snapshot.sessionId,binding:snapshot.stamp,generatedAt:new Date(now).toISOString(),intent,status:alternatives(routes.map(r=>r.status)),checks,routes,boundary:'检查的是指定范围和时间点的执行条件，不保证任务质量或安全；未测试与未知不等于通过。'};
}
