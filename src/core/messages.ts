import type { Capability, NextStep, Status } from './types.ts';
export const LABELS:Record<Capability,string>={
  'web.search':'联网搜索','web.fetch':'网页抓取','files.read':'读取文件','files.write':'写入目标目录','image.inspect':'图片理解','office.create':'办公文档生成','office.render':'文档页面预览','office.convert':'文档转换','office.recalculate':'表格重算','browser.read':'浏览器读取','mcp.list':'MCP 工具连接',
};
export const REASONS:Record<string,string>={
  TOOL_ADMITTED:'工具已向当前步骤开放',TOOL_NOT_VISIBLE:'当前检查范围内未发现所需工具',NO_STEP_ADMISSION:'尚未取得本轮工具准入证据',PRECONDITION_UNKNOWN:'执行条件仍需确认',ROUTE_UNKNOWN:'当前检查对应的模型路由未知',IMAGE_CAPABILITY_UNDECLARED:'当前路由未声明图片输入能力',IMAGE_UNSUPPORTED:'当前路由声明不支持图片输入',SERVICE_MISSING:'所需宿主服务缺失',SKILL_REQUIRED:'需要先加载已安装的 Office 技能',BACKEND_NOT_TESTED:'后端尚未实际测试',READINESS_REFUSED:'后端对当前路由未满足准备条件',FILES_REQUIRED:'需要指定要读取的文件',READ_DENIED:'所选输入不可读取',WRITE_DENIED:'目标不满足当前写入边界',INPUT_MISSING:'所选输入不存在',TOOL_ORIGIN_UNKNOWN:'工具来源或契约尚未验证',MCP_STATUS_UNKNOWN:'已发现工具，但连接状态未知',BROWSER_NOT_TESTED:'浏览器连接尚未测试',AUTHORING_RUNTIME_UNKNOWN:'文档生成运行环境尚未确认',PROBE_PASSED:'指定范围的实际测试通过',PROBE_FAILED:'指定范围的实际测试失败',PROBE_CANCELLED:'测试已取消',PROBE_OUTCOME_UNKNOWN:'测试结果或外部副作用尚未确定',EVIDENCE_STALE:'证据不再适用于当前状态',CAPABILITY_UNKNOWN:'暂无可靠的能力证据',POLICY_OBSERVED:'已读取当前策略',INPUT_OBSERVED:'已检查指定输入',ENGINE_PRESENT:'已发现文档服务，未代表引擎运行成功',MODEL_DECLARED:'已读取当前路由的能力声明',OUTPUT_REQUIRED:'需要选择任务输出目录',MCP_CONNECTED:'所选 MCP 的连接状态已就绪',
};
export function knownReason(code:string):string{return Object.hasOwn(REASONS,code)?code:'CAPABILITY_UNKNOWN';}
export const STATUS_LABELS:Record<Status,string>={ready_unverified:'具备已知条件，尚未测试',verified:'指定测试通过',blocked:'存在已知阻塞',unknown:'还有条件待确认',stale:'证据已过期，需要重新检查'};
export function nextSteps(codes:string[],capability:Capability):NextStep[]{
  const result:NextStep[]=[];
  if(codes.includes('SKILL_REQUIRED'))result.push({id:'load-office-skill',kind:'prepare',label:'在当前会话加载 Office 技能，再从下一步骤复检'});
  if(codes.includes('FILES_REQUIRED')||codes.includes('INPUT_MISSING'))result.push({id:'select-inputs',kind:'prepare',label:'选择可访问的输入文件后重新检查'});
  if(codes.includes('WRITE_DENIED')||codes.includes('OUTPUT_REQUIRED'))result.push({id:'choose-output',kind:'prepare',label:'选择当前权限范围内的输出位置，不扩大权限'});
  if(codes.includes('EVIDENCE_STALE'))result.push({id:'recheck',kind:'prepare',label:'按当前模型和工具状态重新检查'});
  if(codes.includes('READINESS_REFUSED')||codes.includes('SERVICE_MISSING'))result.push({id:'host-settings',kind:'manual',label:'在宿主设置核对相关后端或服务，不把密钥粘贴到对话'});
  if(!result.length)result.push({id:'review-'+capability.replaceAll('.','-'),kind:'manual',label:'查看依据与未验证范围，再选择需要的最小测试'});
  return result;
}
