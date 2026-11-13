import { fingerprint } from '../core/diagnose.ts';
import { parseIntent } from '../core/intent.ts';
import { ReadinessError } from '../core/types.ts';
import type { CapabilityFact, ModelRoute, Requirement, SessionSnapshot, TaskIntent } from '../core/types.ts';
export interface HostContext { get?(name:string):unknown; [name:string]:unknown }
export interface SnapshotAgent { id:string; ctx?:HostContext; session:unknown; model?:{current():ModelRoute|undefined} }
export interface CapturedStep {turn:number;step:number;modelSelection:ModelRoute}
export interface ModelInfo {provider:string;model:string;inputModalities:readonly string[];epoch:number}
export interface CaptureOptions {agent:SnapshotAgent;toolSet?:unknown;capturedStep?:CapturedStep;intent:TaskIntent;epoch:number;now?:number;signal:AbortSignal;modelInfo?:ModelInfo}
interface ToolSchema {name:string;parameters?:unknown}
interface ToolPort {schemas(agent:SnapshotAgent,toolSet?:unknown):readonly ToolSchema[]}
interface DirectoryPort {get(session:unknown):string}
interface Policy {mode?:string;workspaceRoot?:string;additionalWritableRoots?:readonly string[]}
interface SandboxPort {resolve(input:{session:unknown}):Policy}
interface ApprovalPort {overrideOf(session:unknown):string|undefined;config?:{policy?:string}}
interface WebPort {searchReady?(provider?:string):Promise<boolean>;fetchReady?(provider?:string):Promise<boolean>}
interface Target {readonly displayPath?:string}
interface FsPort {resolve(path:string,options:{cwd?:string;signal:AbortSignal}):Promise<Target>;stat(target:Target,signal:AbortSignal):Promise<{type:string;size?:number;version?:unknown}|undefined>;processPath(target:Target):string;contains(parent:Target,child:Target):boolean;readByteRange?(target:Target,range:{offset:number;length:number},signal:AbortSignal):Promise<Uint8Array>}
function service<T>(ctx:HostContext,name:string):T|undefined {try{return (typeof ctx.get==='function'?ctx.get(name):ctx[name]) as T|undefined;}catch{return undefined;}}
function toolNames(req:Requirement):string[]{switch(req.capability){
  case 'web.search':return ['web_search'];case 'web.fetch':return ['web_fetch'];case 'files.read':return ['read'];case 'files.write':return ['write'];case 'image.inspect':return ['read_image'];case 'office.create':return ['bash','pwsh'];case 'office.render':return ['office_render'];case 'office.convert':return ['office_convert'];case 'office.recalculate':return ['office_recalculate'];default:return [];
}}
function selectedNames(req:Requirement,names:Set<string>):string[]{
  if(req.capability==='browser.read')return [...names].filter(n=>/^mcp__[^_][A-Za-z0-9_-]*__browser_(navigate|snapshot)$/.test(n));
  if(req.capability==='mcp.list')return [...names].filter(n=>req.server?n.startsWith('mcp__'+req.server+'__'):/^mcp__[A-Za-z0-9_-]+__/.test(n));
  return toolNames(req).filter(n=>names.has(n));
}
export async function captureSnapshot(host:HostContext,options:CaptureOptions):Promise<SessionSnapshot>{
  const {agent,toolSet,signal}=options;if(!agent||typeof agent.id!=='string'||!agent.id||!agent.session)throw new ReadinessError('AGENT_REQUIRED','A live session is required');
  signal.throwIfAborted();const ctx=agent.ctx??host;const now=options.now??Date.now(),at=new Date(now).toISOString();const intent=parseIntent(options.intent);
  const toolPort=service<ToolPort>(ctx,'tools');if(!toolPort)throw new ReadinessError('TOOL_REGISTRY_UNAVAILABLE','Tool registry is unavailable');
  const registered=toolPort.schemas(agent);const admitted=toolSet===undefined?[]:toolPort.schemas(agent,toolSet);
  if(registered.length>4096||admitted.length>4096)throw new ReadinessError('CATALOG_TOO_LARGE','Tool catalog exceeds diagnostic limit');
  const knownNames=new Set(registered.map(t=>t.name));const names=new Set((toolSet===undefined?registered:admitted).map(t=>t.name));
  const route=options.capturedStep?.modelSelection?{...options.capturedStep.modelSelection}:null;
  let nextRoute:ModelRoute|undefined;try{nextRoute=agent.model?.current();}catch{/* No new model resolution. */}
  let cwd:string|undefined;try{cwd=service<DirectoryPort>(ctx,'workingDirectory')?.get(agent.session);}catch{/* Unknown is not permission. */}
  let policy:Policy={};try{policy=service<SandboxPort>(ctx,'sandboxPolicy')?.resolve({session:agent.session})??{};}catch{/* Report unknown below. */}
  const sandbox:SessionSnapshot['sandbox']=['read-only','workspace-write','danger-full-access'].includes(policy.mode??'')?policy.mode as SessionSnapshot['sandbox']:'unknown';
  let approval:SessionSnapshot['approval']='unknown';try{const p=service<ApprovalPort>(ctx,'approval');const v=p?.overrideOf(agent.session)??p?.config?.policy;if(v==='ask'||v==='never')approval=v;}catch{/* Unknown is not approval. */}
  const fs=service<FsPort>(ctx,'fs');const web=service<WebPort>(ctx,'web');const engine=service<unknown>(ctx,'officeKit')!==undefined;
  const scope=toolSet===undefined?'registered':'step';
  const facts:Record<string,CapabilityFact>={};const inputs:Array<unknown>=[];
  const matchingInfo=options.modelInfo&&route&&options.modelInfo.epoch===options.epoch&&options.modelInfo.provider===route.provider&&options.modelInfo.model===route.model?options.modelInfo:undefined;
  for(const req of intent.requirements){
    signal.throwIfAborted();const key=req.server?req.capability+':'+req.server:req.capability;
    if(facts[key])continue;
    const matched=selectedNames(req,names);const available=req.capability==='browser.read'?matched.some(n=>n.endsWith('__browser_navigate')&&names.has(n.slice(0,-'navigate'.length)+'snapshot')):matched.length>0;
    const fact:CapabilityFact={availability:scope==='step'?(available?'available':'absent'):'unknown',preconditions:'unknown',reasonCodes:[scope==='step'?(available?'BACKEND_NOT_TESTED':'TOOL_NOT_VISIBLE'):'NO_STEP_ADMISSION'],evidence:[{kind:'declaration',code:scope==='step'&&available?'TOOL_ADMITTED':'NO_STEP_ADMISSION',observedAt:at}]};
    const block=(code:string)=>{fact.preconditions='unmet';fact.reasonCodes=[code];};
    const uncertain=(code:string)=>{if(fact.preconditions!=='unmet'){fact.preconditions='unknown';fact.reasonCodes=[code];}};
    if(req.capability.startsWith('office.')&&req.capability!=='office.create'){
      const entry=toolNames(req)[0];
      if(!available&&knownNames.has(entry))block('SKILL_REQUIRED');
      else if(available&&!engine)block('SERVICE_MISSING');
      else if(available)uncertain('ENGINE_PRESENT');
    }else if(req.capability==='office.create')uncertain('AUTHORING_RUNTIME_UNKNOWN');
    else if(req.capability==='web.search'||req.capability==='web.fetch'){
      if(available&&!web)block('SERVICE_MISSING');
      else if(available&&!route)uncertain('ROUTE_UNKNOWN');
      else if(available&&web&&route){try{const ready=req.capability==='web.search'?await web.searchReady?.(route.provider):await web.fetchReady?.(route.provider);if(ready===false)block('READINESS_REFUSED');else uncertain('BACKEND_NOT_TESTED');}catch{uncertain('PRECONDITION_UNKNOWN');}}
    }else if(req.capability==='image.inspect'){
      if(!route)uncertain('ROUTE_UNKNOWN');else if(!matchingInfo)uncertain('IMAGE_CAPABILITY_UNDECLARED');
      else if(!matchingInfo.inputModalities.includes('image'))block('IMAGE_UNSUPPORTED');
      else if(service(ctx,'attachments')===undefined)block('SERVICE_MISSING');
      else{fact.preconditions='satisfied';fact.reasonCodes=['MODEL_DECLARED'];}
    }else if(req.capability==='mcp.list')uncertain('MCP_STATUS_UNKNOWN');
    else if(req.capability==='browser.read')uncertain('BROWSER_NOT_TESTED');
    else if(req.capability==='files.read'){
      if(!intent.files.length)block('FILES_REQUIRED');else if(!fs||!cwd)uncertain('SERVICE_MISSING');
      else{fact.preconditions='satisfied';fact.reasonCodes=['INPUT_OBSERVED'];for(const path of intent.files){try{const target=await fs.resolve(path,{cwd,signal});const meta=await fs.stat(target,signal);inputs.push([path,meta?.type,meta?.version,meta?.size]);if(!meta||meta.type!=='file'){block('INPUT_MISSING');continue;}if(!fs.readByteRange){uncertain('PRECONDITION_UNKNOWN');continue;}await fs.readByteRange(target,{offset:0,length:1},signal);}catch{signal.throwIfAborted();block('READ_DENIED');}}}
    }else if(req.capability==='files.write'){
      if(sandbox==='read-only')block('WRITE_DENIED');else if(!intent.outputDirectory)block('OUTPUT_REQUIRED');else if(!fs||!cwd||sandbox==='unknown')uncertain('PRECONDITION_UNKNOWN');
      else{try{const output=await fs.resolve(intent.outputDirectory,{cwd,signal});const meta=await fs.stat(output,signal);inputs.push(['output',fs.processPath(output),meta?.type]);if(!meta||meta.type!=='directory')block('INPUT_MISSING');else if(sandbox==='workspace-write'){
        const roots=[policy.workspaceRoot,...policy.additionalWritableRoots??[]].filter((r):r is string=>typeof r==='string');let inside=false;for(const root of roots){const target=await fs.resolve(root,{signal});if(fs.contains(target,output))inside=true;}
        if(!inside)block('WRITE_DENIED');else{fact.preconditions='satisfied';fact.reasonCodes=['POLICY_OBSERVED'];}
      }else{fact.preconditions='satisfied';fact.reasonCodes=['POLICY_OBSERVED'];}}catch{signal.throwIfAborted();uncertain('PRECONDITION_UNKNOWN');}}
    }
    facts[key]=fact;
  }
  signal.throwIfAborted();
  const schemaBinding=(toolSet===undefined?registered:admitted).map(t=>[t.name,fingerprint(t.parameters??{})]).sort((a,b)=>a[0].localeCompare(b[0]));
  const stamp=fingerprint({sessionId:agent.id,epoch:options.epoch,route,nextRoute,scope,cwd,sandbox,approval,policyRoot:policy.workspaceRoot,extraRoots:policy.additionalWritableRoots,schemas:schemaBinding,task:intent,engine,modelInfo:matchingInfo,inputs,conditions:Object.entries(facts).map(([k,f])=>[k,f.availability,f.preconditions,f.reasonCodes])});
  return {sessionId:agent.id,stamp,observedAt:at,scope,route,cwd,sandbox,approval,facts};
}
