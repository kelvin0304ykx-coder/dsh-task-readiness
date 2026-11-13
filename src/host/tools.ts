import { TEMPLATE_IDS, templateIntent } from '../core/intent.ts';
import type { JournalRecord } from '../core/journal.ts';
import { LABELS, STATUS_LABELS } from '../core/messages.ts';
import { modelReport } from '../core/privacy.ts';
import { CAPABILITIES, ReadinessError } from '../core/types.ts';
import type { Capability, Report } from '../core/types.ts';
import { probeLimitation, supportsProbe } from './probes.ts';
import type { ReadinessService } from './service.ts';
import type { CapturedStep, SnapshotAgent } from './snapshot.ts';
/** Lossless JSON value, mirroring the host's own vocabulary without importing it. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
/** The host's enforced JSON Schema subset, declared locally so the runtime has no host imports. */
export interface JsonSchemaNode {
  type?: JsonSchemaType;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaNode;
  enum?: (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  description?: string;
  title?: string;
}
interface TextBlock { type: 'text'; text: string }
interface CallView { card: 'generic'; title?: string; kind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'; locations?: Array<{ path: string }> }
interface ResultView { card: 'generic'; title?: string; content?: TextBlock[] }
/** A registry-ready tool definition built without importing any host package at runtime. */
export interface LocalToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchemaNode;
  readonly output: { readonly schema: JsonSchemaNode; render(args: unknown, value: Json): TextBlock[]; presentationMeta?(args: unknown, value: Json): Json };
  execute(args: unknown, exec: ToolExecLike): Promise<Json>;
  isConcurrencySafe?(args: unknown): boolean;
  presentCall?(args: unknown): CallView | undefined;
  presentResult?(args: unknown, result: unknown): ResultView | undefined;
}
export interface ToolExecLike { agent?: unknown; toolSet?: unknown; signal: AbortSignal; callId?: unknown; name: string }
export interface ToolDeps {
  readiness: ReadinessService;
  journal: { list(sessionId: string): JournalRecord[] };
  steps: WeakMap<object, CapturedStep>;
}
const CHECK_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'One-line task name; no confidential detail. Required unless a template is used.' },
    template: { type: 'string', enum: [...TEMPLATE_IDS], description: 'Built-in task template; replaces title and requirements.' },
    requirements: {
      type: 'array', description: 'Capability requirements of the task.',
      items: { type: 'object', additionalProperties: false, required: ['id', 'capability'], properties: { id: { type: 'string' }, capability: { type: 'string', enum: [...CAPABILITIES] }, server: { type: 'string' } } },
    },
    routes: {
      type: 'array', description: 'Alternative capability routes; omission means one route needing every requirement.',
      items: { type: 'object', additionalProperties: false, required: ['id', 'requires'], properties: { id: { type: 'string' }, requires: { type: 'array', items: { type: 'string' } } } },
    },
    files: { type: 'array', items: { type: 'string' }, description: 'Explicit input paths the task reads.' },
    outputDirectory: { type: 'string', description: 'Directory the task writes into.' },
  },
};
const PLAN_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  required: ['reportId', 'requirementId'],
  properties: {
    reportId: { type: 'string', description: 'Report id returned by readiness_check.' },
    requirementId: { type: 'string', description: 'Requirement id inside that report.' },
    mode: { type: 'string', enum: ['plan', 'run', 'cancel'], description: 'plan describes the probe only; run needs host approval; cancel withdraws a plan id.' },
    planId: { type: 'string', description: 'Existing plan id for cancel.' },
  },
};
const REMEDY_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  required: ['reportId', 'actionId', 'value', 'expectedOptionsRevision'],
  properties: {
    reportId: { type: 'string' },
    actionId: { type: 'string', enum: ['set-output', 'choose-route', 'restore-options'] },
    value: { type: 'string', description: 'Chosen output directory, route id, or operation id to restore.' },
    expectedOptionsRevision: { type: 'integer', description: 'Task-options revision the caller observed.' },
    mode: { type: 'string', enum: ['plan', 'run', 'cancel'], description: 'plan describes the change only; run needs host approval.' },
    planId: { type: 'string' },
  },
};
const CHECK_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    id: { type: 'string' }, revision: { type: 'integer' }, version: { type: 'integer' }, generatedAt: { type: 'string' }, status: { type: 'string' }, boundary: { type: 'string' },
    checks: { type: 'array' }, routes: { type: 'array' }, nextSteps: { type: 'array' }, probeOptions: { type: 'array' }, unresolvedActions: { type: 'integer' },
  },
};
const ACTION_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    status: { type: 'string' }, planId: { type: 'string' }, cost: { type: 'string' }, effects: { type: 'array' }, expiresAt: { type: 'string' }, note: { type: 'string' }, receipt: {}, report: {},
  },
};
function asJson(value: unknown): Json { return value as Json; }
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function body(args: unknown): Record<string, unknown> { return record(args); }
function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || !value.trim()) throw new ReadinessError('INVALID_INTENT', '缺少参数：' + key);
  return value;
}
function requiredRequirements(source: Record<string, unknown>): unknown {
  if (!Array.isArray(source.requirements) || source.requirements.length === 0) throw new ReadinessError('INVALID_INTENT', '需要 requirements 或 template');
  return source.requirements;
}
function statusText(status: string): string { return STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? status; }
const ACTION_STATUS_LABELS: Record<string, string> = { planned: '计划已生成，尚未执行', confirmed: '已确认，等待执行', running: '执行中', succeeded: '已成功', failed: '失败', cancelled: '已取消', outcome_unknown: '结果待确认' };
function actionStatusText(status: string): string { return ACTION_STATUS_LABELS[status] ?? status; }
function contextOf(exec: ToolExecLike, steps: WeakMap<object, CapturedStep>) {
  const agent = exec.agent as SnapshotAgent | undefined;
  if (!agent || typeof agent.id !== 'string' || !agent.id) throw new ReadinessError('AGENT_REQUIRED', '检查只在会话步骤内进行');
  const capturedStep = steps.get(agent);
  return { agent, signal: exec.signal, toolName: exec.name, ...(exec.toolSet === undefined ? {} : { toolSet: exec.toolSet }), ...(capturedStep === undefined ? {} : { capturedStep }), ...(exec.callId === undefined ? {} : { callId: String(exec.callId) }) };
}
function renderCheck(value: Json): string {
  const report = record(value);
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const lines = ['任务就绪检查 ' + String(report.id ?? '') + '：' + String(report.status ?? 'unknown')];
  for (const item of checks) {
    const check = record(item);
    lines.push('- ' + String(check.label ?? check.capability ?? '') + '：' + statusText(String(check.status)));
  }
  const steps = Array.isArray(report.nextSteps) ? report.nextSteps : [];
  for (const item of steps) {
    const step = record(item);
    const actions = Array.isArray(step.actions) ? step.actions.map((action) => String(record(action).label ?? '')).filter(Boolean) : [];
    const label = LABELS[String(step.capability) as Capability];
    if (actions.length) lines.push('  下一步（' + (label ?? String(step.capability)) + '）：' + actions.join('；'));
  }
  lines.push(String(report.boundary ?? ''));
  return lines.join('\n');
}
function renderAction(value: Json): string {
  const result = record(value);
  const lines = ['动作状态：' + actionStatusText(String(result.status ?? 'unknown'))];
  if (result.planId) lines.push('计划：' + String(result.planId) + (result.cost ? '，费用：' + String(result.cost) : '') + (Array.isArray(result.effects) ? '，影响：' + result.effects.map(String).join('、') : ''));
  if (result.receipt) lines.push('回执：' + JSON.stringify(result.receipt));
  if (result.note) lines.push(String(result.note));
  return lines.join('\n');
}
function checkMeta(value: Json): Json {
  const report = record(value);
  const checks = Array.isArray(report.checks) ? report.checks : [];
  return asJson({
    id: String(report.id ?? ''), status: String(report.status ?? ''), generatedAt: String(report.generatedAt ?? ''), boundary: String(report.boundary ?? ''),
    checks: checks.map((item) => { const check = record(item); const capability = String(check.capability ?? ''); return { capability, label: LABELS[capability as Capability] ?? capability, status: String(check.status ?? ''), verification: String(check.verification ?? '') }; }),
    routes: (Array.isArray(report.routes) ? report.routes : []).map((item) => ({ status: String(record(item).status ?? '') })),
  });
}
function actionMeta(value: Json): Json {
  const result = record(value);
  const receipt = record(result.receipt);
  const report = record(result.report);
  return asJson({
    planId: String(result.planId ?? ''), status: String(result.status ?? ''), cost: String(result.cost ?? ''),
    effects: Array.isArray(result.effects) ? result.effects.map(String) : [],
    receiptCode: String(receipt.code ?? ''), receiptStatus: String(receipt.status ?? ''),
    reportId: String(report.id ?? ''), reportStatus: String(report.status ?? ''),
  });
}
function presentCheckCall(args: unknown): CallView {
  const input = body(args);
  const name = typeof input.template === 'string' ? '模板 ' + input.template : typeof input.title === 'string' ? input.title.slice(0, 120) : '任务';
  const files = Array.isArray(input.files) ? input.files.filter((item): item is string => typeof item === 'string').slice(0, 4).map((path) => ({ path })) : [];
  return { card: 'generic', title: '功能体检：' + name, kind: 'read', ...(files.length === 0 ? {} : { locations: files }) };
}
function presentActionCall(verb: string) {
  return (args: unknown): CallView => {
    const input = body(args);
    const target = typeof input.requirementId === 'string' ? input.requirementId : typeof input.actionId === 'string' ? input.actionId : '';
    return { card: 'generic', title: verb + (target === '' ? '' : '：' + target), kind: 'execute' };
  };
}
function presentCheckResult(_args: unknown, result: unknown): ResultView | undefined {
  const meta = record(record(result).meta);
  const checks = Array.isArray(meta.checks) ? meta.checks : [];
  if (typeof meta.id !== 'string' || meta.id === '' || checks.length === 0) return undefined;
  const lines = ['功能体检结果：' + statusText(String(meta.status))];
  for (const item of checks) {
    const check = record(item);
    lines.push('- ' + String(check.label || check.capability) + '：' + statusText(String(check.status)));
  }
  if (typeof meta.boundary === 'string' && meta.boundary !== '') lines.push(meta.boundary);
  return { card: 'generic', title: '功能体检：' + statusText(String(meta.status)), content: [{ type: 'text', text: lines.join('\n') }] };
}
function presentActionResult(_args: unknown, result: unknown): ResultView | undefined {
  const meta = record(record(result).meta);
  if (typeof meta.planId !== 'string' || meta.planId === '') return undefined;
  const lines = ['动作状态：' + actionStatusText(String(meta.status))];
  if (typeof meta.receiptCode === 'string' && meta.receiptCode !== '') lines.push('回执：' + meta.receiptCode);
  if (typeof meta.reportStatus === 'string' && meta.reportStatus !== '') lines.push('复检：' + statusText(meta.reportStatus));
  return { card: 'generic', content: [{ type: 'text', text: lines.join('\n') }] };
}
function probeOptions(report: Report) {
  return report.checks
    .filter((check) => check.status === 'ready_unverified' || check.status === 'unknown')
    .map((check) => ({ capability: check.capability, requirementId: check.id, probe: supportsProbe(check.capability), limitation: probeLimitation(check.capability) }));
}
export function createTools(deps: ToolDeps): LocalToolDefinition[] {
  const { readiness, journal, steps } = deps;
  return [
    {
      name: 'readiness_check',
      description: '只读检查当前会话能否开始一项任务：本轮工具准入、模型路由、工作目录、写入边界、文档引擎与 MCP 可见性，给出逐项状态、依据和下一步。可用 requirements 表达自然语言任务的能力要求，也可用内置 template。不执行任务、不联网测试、不改配置。',
      parameters: CHECK_PARAMETERS,
      output: { schema: CHECK_OUTPUT_SCHEMA, render: (_args: unknown, value: Json) => [{ type: 'text', text: renderCheck(value) }], presentationMeta: (_args: unknown, value: Json) => checkMeta(value) },
      isConcurrencySafe: () => true,
      presentCall: (args: unknown) => presentCheckCall(args),
      presentResult: (args: unknown, result: unknown) => presentCheckResult(args, result),
      execute: async (args: unknown, exec: ToolExecLike) => {
        const input = body(args);
        const context = contextOf(exec, steps);
        const files = Array.isArray(input.files) ? input.files : [];
        const output = typeof input.outputDirectory === 'string' ? { outputDirectory: input.outputDirectory } : {};
        const useTemplate = typeof input.template === 'string';
        if (useTemplate && (input.requirements !== undefined || input.routes !== undefined)) throw new ReadinessError('INVALID_INTENT', '模板已定义能力要求，不要再传 requirements 或 routes');
        const intent = useTemplate
          ? { ...templateIntent(input.template as string), files, ...output }
          : { version: 1, title: requiredString(input, 'title'), requirements: requiredRequirements(input), ...(input.routes === undefined ? {} : { routes: input.routes }), files, ...output };
        const report = await readiness.check(context, intent);
        return asJson({ ...modelReport(report), probeOptions: probeOptions(report), unresolvedActions: journal.list(context.agent.id).filter((row) => row.resultAt === undefined).length });
      },
    },
    {
      name: 'readiness_probe',
      description: '为报告中的一项能力生成最小探测计划；run 模式先请求宿主确认，只有宿主返回 allowed-once 才执行，超时或取消保留未知结果；cancel 撤回计划。',
      parameters: PLAN_PARAMETERS,
      output: { schema: ACTION_OUTPUT_SCHEMA, render: (_args: unknown, value: Json) => [{ type: 'text', text: renderAction(value) }], presentationMeta: (_args: unknown, value: Json) => actionMeta(value) },
      isConcurrencySafe: () => false,
      presentCall: presentActionCall('生成探测计划'),
      presentResult: (args: unknown, result: unknown) => presentActionResult(args, result),
      execute: async (args: unknown, exec: ToolExecLike) => {
        const input = body(args);
        const context = contextOf(exec, steps);
        const mode = typeof input.mode === 'string' ? input.mode : 'plan';
        if (mode === 'cancel') {
          const planId = requiredString(input, 'planId');
          readiness.cancel(context.agent.id, planId);
          return asJson({ status: 'cancelled', planId, note: '已撤回计划；未执行的部分不会补做。' });
        }
        const reportId = requiredString(input, 'reportId');
        const report = readiness.getReport(context.agent.id, reportId);
        const requirementId = requiredString(input, 'requirementId');
        const requirement = report.intent.requirements.find((item) => item.id === requirementId);
        if (!requirement) throw new ReadinessError('INVALID_PLAN', '报告中没有该能力项');
        const plan = readiness.plan(context.agent.id, reportId, { kind: 'probe', probeId: requirement.capability, requirementId });
        const summary = { planId: plan.id, status: plan.status, cost: plan.cost, effects: plan.effects, expiresAt: plan.expiresAt };
        if (mode !== 'run') return asJson({ ...summary, note: '计划已生成，尚未执行；run 会先请求宿主确认。' });
        const result = await readiness.run(context, plan.id);
        return asJson({ ...summary, status: result.receipt.status, receipt: result.receipt, report: modelReport(result.report) });
      },
    },
    {
      name: 'readiness_remedy',
      description: '为本插件拥有的任务选项生成受控处理计划（输出目录、替代路线、恢复上一版本）；run 模式需要宿主确认，只改本插件自有状态，不改宿主模型、权限或其它插件配置。',
      parameters: REMEDY_PARAMETERS,
      output: { schema: ACTION_OUTPUT_SCHEMA, render: (_args: unknown, value: Json) => [{ type: 'text', text: renderAction(value) }], presentationMeta: (_args: unknown, value: Json) => actionMeta(value) },
      isConcurrencySafe: () => false,
      presentCall: presentActionCall('准备处理'),
      presentResult: (args: unknown, result: unknown) => presentActionResult(args, result),
      execute: async (args: unknown, exec: ToolExecLike) => {
        const input = body(args);
        const context = contextOf(exec, steps);
        const mode = typeof input.mode === 'string' ? input.mode : 'plan';
        if (mode === 'cancel') {
          const planId = requiredString(input, 'planId');
          readiness.cancel(context.agent.id, planId);
          return asJson({ status: 'cancelled', planId, note: '已撤回计划；未执行的部分不会补做。' });
        }
        const reportId = requiredString(input, 'reportId');
        const actionId = requiredString(input, 'actionId');
        const value = requiredString(input, 'value');
        const expectedOptionsRevision = typeof input.expectedOptionsRevision === 'number' ? input.expectedOptionsRevision : 0;
        const plan = readiness.plan(context.agent.id, reportId, { kind: 'remedy', actionId, value, expectedOptionsRevision });
        const summary = { planId: plan.id, status: plan.status, cost: plan.cost, effects: plan.effects, expiresAt: plan.expiresAt };
        if (mode !== 'run') return asJson({ ...summary, note: '计划已生成，尚未执行；run 会先请求宿主确认。' });
        const result = await readiness.run(context, plan.id);
        return asJson({ ...summary, status: result.receipt.status, receipt: result.receipt, report: modelReport(result.report) });
      },
    },
  ];
}
