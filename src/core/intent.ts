import { CAPABILITIES, ReadinessError } from './types.ts';
import type { Capability, Language, Requirement, TaskIntent, TaskRoute } from './types.ts';
function invalid(message: string): never { throw new ReadinessError('INVALID_INTENT',message); }
export function strictObject(value: unknown, keys: readonly string[]): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value)!==Object.prototype) invalid('Expected a plain JSON object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid('Unexpected field: '+key);
  return value as Record<string,unknown>;
}
export function boundedText(value: unknown, max: number, label: string): string {
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid('Invalid '+label);
  return value.trim();
}
function id(value:unknown):string { const text=boundedText(value,64,'identifier');if(!/^[a-zA-Z0-9_-]+$/.test(text))invalid('Invalid identifier');return text; }
function list(value:unknown,min:number,max:number,label:string):unknown[]{if(!Array.isArray(value)||value.length<min||value.length>max)invalid('Invalid '+label+' count');return value;}
export function parseIntent(input:unknown):TaskIntent {
  const v=strictObject(input,['version','title','requirements','routes','files','outputDirectory']);
  if(v.version!==1)invalid('Unsupported task version');
  const requirements:Requirement[]=list(v.requirements,1,24,'requirement').map(item=>{
    const r=strictObject(item,['id','capability','server']);
    if(!CAPABILITIES.includes(r.capability as Capability))invalid('Unknown capability');
    const result:Requirement={id:id(r.id),capability:r.capability as Capability};
    if(r.server!==undefined){if(result.capability!=='mcp.list')invalid('Server is only valid for MCP');const s=boundedText(r.server,32,'MCP namespace');if(!/^[A-Za-z0-9_-]+$/.test(s))invalid('Invalid MCP namespace');result.server=s;}
    return result;
  });
  const ids=new Set(requirements.map(r=>r.id));if(ids.size!==requirements.length)invalid('Duplicate requirement id');
  const routes:TaskRoute[]=v.routes===undefined?[{id:'primary',requires:[...ids]}]:list(v.routes,1,8,'route').map(item=>{
    const r=strictObject(item,['id','requires']);const refs=list(r.requires,1,24,'route dependency').map(id);
    if(new Set(refs).size!==refs.length||refs.some(ref=>!ids.has(ref)))invalid('Invalid route dependency');return {id:id(r.id),requires:refs};
  });
  if(new Set(routes.map(r=>r.id)).size!==routes.length)invalid('Duplicate route id');
  const files=list(v.files??[],0,32,'file').map(v=>boundedText(v,4096,'file path'));
  const out:TaskIntent={version:1,title:boundedText(v.title,200,'title'),requirements,routes,files:[...new Set(files)]};
  if(v.outputDirectory!==undefined)out.outputDirectory=boundedText(v.outputDirectory,4096,'output directory');
  return out;
}
const templates:Record<string,{title:string;capabilities:Capability[]}>= {
  research:{title:'联网查资料',capabilities:['web.search','web.fetch']},
  documents:{title:'制作并预览办公文档',capabilities:['files.write','office.create','office.render']},
  images:{title:'读取图片',capabilities:['files.read','image.inspect']},
  browser:{title:'打开并读取网页',capabilities:['browser.read']},
  mcp:{title:'检查 MCP 工具连接',capabilities:['mcp.list']},
};
export const TEMPLATE_IDS=Object.keys(templates);
export function templateIntent(templateId:string):TaskIntent {
  const t=Object.hasOwn(templates,templateId)?templates[templateId]:undefined;
  if(!t)invalid('Unknown task template');
  return parseIntent({version:1,title:t.title,requirements:t.capabilities.map((capability,i)=>({id:'step'+(i+1),capability})),files:[]});
}
export function handoffPrompt(input:string,language:Language='zh'):string {
  const text=boundedText(input,6000,'task description');
  const instruction=language==='zh'?'请把下面的用户需求转换为任务能力要求，并调用 readiness_check 检查当前会话。这里只做体检，不要执行原任务、联网测试、安装、改配置或代替用户确认。未知能力如实保留；需要输入资料时询问用户。':'Translate the user task below into capability requirements and call readiness_check for this session. Check only: do not execute the task, probes, installs, configuration changes or user approvals. Preserve unknowns and ask for necessary input.';
  return instruction+'\n'+JSON.stringify({userTask:text});
}
