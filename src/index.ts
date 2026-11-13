import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ActionJournal, JournalEvent } from './core/actions.ts';
import type { JournalRecord } from './core/journal.ts';
import { LABELS, STATUS_LABELS } from './core/messages.ts';
import { modelReport } from './core/privacy.ts';
import { CAPABILITIES, ReadinessError } from './core/types.ts';
import type { Capability, ModelRoute, Report } from './core/types.ts';
import { openDurableJournal } from './host/journal-domain.ts';
import type { JournalFacility } from './host/journal-domain.ts';
import { createProbeExecutor, probeLimitation, supportsProbe } from './host/probes.ts';
import { ReadinessService } from './host/service.ts';
import type { CheckContext } from './host/service.ts';
import { captureSnapshot } from './host/snapshot.ts';
import type { CapturedStep, HostContext, ModelInfo, SnapshotAgent } from './host/snapshot.ts';
/** Cordis plugin name used by Loader diagnostics. */
export const name = 'task-readiness';
/** The registry itself is required; every other service is read defensively per call. */
export const inject = ['tools'];
interface PluginContext extends HostContext {
  on?(event: string, listener: (...args: never[]) => unknown): unknown;
  effect?(setup: () => () => void): unknown;
}
interface ApprovalPort { request?(request: { agent: unknown; toolName: string; callId?: unknown; reason?: string; signal?: AbortSignal }): Promise<string> }
interface LlmPort { resolveModelInfo?(selection: unknown): Promise<{ inputModalities?: readonly string[] } | undefined> | { inputModalities?: readonly string[] } | undefined }
interface StoragePort { open(spec: unknown): Promise<{ table(name: string): unknown; close(): Promise<void> }> }
type CommandResultLike = { kind: 'success'; text?: string } | { kind: 'error'; text: string };
interface CommandPort { register(definition: { name: string; description: string; handler: (invocation: { agent: { id?: string }; rawInput: string }) => CommandResultLike | Promise<CommandResultLike> }): () => void }
interface ToolExecLike { agent?: unknown; toolSet?: unknown; signal: AbortSignal; callId?: unknown; name: string }
function service<T>(ctx: HostContext, key: string): T | undefined { try { return (typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]) as T | undefined; } catch { return undefined; } }
function listen(ctx: PluginContext, event: string, handler: (...args: never[]) => unknown): void {
  const register = (ctx as { on?: (name: string, listener: (...args: unknown[]) => unknown) => unknown }).on;
  if (typeof register === 'function') register.call(ctx, event, handler as (...args: unknown[]) => unknown);
}
function contextOf(exec: ToolExecLike, steps: WeakMap<object, CapturedStep>): CheckContext {
  const agent = exec.agent as SnapshotAgent | undefined;
  if (!agent || typeof agent.id !== 'string' || !agent.id) throw new ReadinessError('AGENT_REQUIRED', '检查只在会话步骤内进行');
  const capturedStep = steps.get(agent);
  return { agent, signal: exec.signal, toolName: exec.name, ...(exec.toolSet === undefined ? {} : { toolSet: exec.toolSet }), ...(capturedStep === undefined ? {} : { capturedStep }), ...(exec.callId === undefined ? {} : { callId: String(exec.callId) }) };
}
/** Journal that refuses writes when the host offers no durable store; diagnostics still work. */
class UnavailableJournal implements ActionJournal {
  async record(_event: JournalEvent): Promise<void> { await Promise.resolve(); throw new ReadinessError('JOURNAL_UNAVAILABLE', '本机未提供持久化存储，动作日志无法写入，因此不执行任何探测或处理'); }
  list(_sessionId: string): JournalRecord[] { return []; }
}
type JournalHandle = { journal: ActionJournal & { list(sessionId: string): JournalRecord[] }; close(): Promise<void> };
async function openJournal(ctx: HostContext): Promise<JournalHandle> {
  const storage = service<StoragePort>(ctx, 'storageDomain');
  if (storage) {
    try {
      const opened = await openDurableJournal(storage as unknown as JournalFacility);
      return { journal: opened.journal, close: opened.close };
    } catch { /* Fall through: diagnostics without a durable journal. */ }
  }
  return { journal: new UnavailableJournal(), close: async () => { await Promise.resolve(); } };
}
const CHECK_PARAMETERS = {
  title: { type: 'string', required: true, description: 'One-line task name; no confidential detail.' },
  requirements: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, capability: { type: 'string', required: true, enum: [...CAPABILITIES] }, server: { type: 'string' } } } },
  routes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, requires: { type: 'array', required: true, items: { type: 'string' } } } } },
  files: { type: 'array', items: { type: 'string' } },
  outputDirectory: { type: 'string' },
} as const;
const PLAN_PARAMETERS = {
  reportId: { type: 'string', required: true, description: 'Report id returned by readiness_check.' },
  requirementId: { type: 'string', required: true, description: 'Requirement id inside that report.' },
  mode: { type: 'string', enum: ['plan', 'run', 'cancel'], description: 'plan describes the probe only; run needs host approval; cancel withdraws a plan id.' },
  planId: { type: 'string', description: 'Existing plan id for cancel.' },
} as const;
const REMEDY_PARAMETERS = {
  reportId: { type: 'string', required: true },
  actionId: { type: 'string', required: true, enum: ['set-output', 'choose-route', 'restore-options'] },
  value: { type: 'string', required: true, description: 'Chosen output directory, route id, or operation id to restore.' },
  expectedOptionsRevision: { type: 'integer', required: true, description: 'Task-options revision the caller observed.' },
  mode: { type: 'string', enum: ['plan', 'run', 'cancel'], description: 'plan describes the change only; run needs host approval.' },
  planId: { type: 'string' },
} as const;
const CHECK_OUTPUT = {
  schema: { type: 'object' as const, additionalProperties: false, properties: {
    id: { type: 'string' as const }, revision: { type: 'integer' as const }, version: { type: 'integer' as const }, generatedAt: { type: 'string' as const }, status: { type: 'string' as const }, boundary: { type: 'string' as const },
    checks: { type: 'array' as const }, routes: { type: 'array' as const }, nextSteps: { type: 'array' as const }, probeOptions: { type: 'array' as const }, unresolvedActions: { type: 'integer' as const },
  } },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: renderCheck(value) }],
};
const ACTION_OUTPUT = {
  schema: { type: 'object' as const, additionalProperties: false, properties: {
    status: { type: 'string' as const }, planId: { type: 'string' as const }, cost: { type: 'string' as const }, effects: { type: 'array' as const }, expiresAt: { type: 'string' as const }, note: { type: 'string' as const }, receipt: { type: 'json' as const }, report: { type: 'json' as const },
  } },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: renderAction(value) }],
};
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function renderCheck(value: unknown): string {
  const report = record(value);
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const lines = ['任务就绪检查 ' + String(report.id ?? '') + '：' + String(report.status ?? 'unknown')];
  for (const item of checks) {
    const check = record(item);
    const status = String(check.status);
    lines.push('- ' + String(check.label ?? check.capability ?? '') + '：' + (STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? status));
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
function renderAction(value: unknown): string {
  const result = record(value);
  const lines = ['动作状态：' + String(result.status ?? 'unknown')];
  if (result.planId) lines.push('计划：' + String(result.planId) + (result.cost ? '，费用：' + String(result.cost) : '') + (Array.isArray(result.effects) ? '，影响：' + result.effects.map(String).join('、') : ''));
  if (result.receipt) lines.push('回执：' + JSON.stringify(result.receipt));
  if (result.note) lines.push(String(result.note));
  return lines.join('\n');
}
function probeOptions(report: Report) {
  return report.checks
    .filter((check) => check.status === 'ready_unverified' || check.status === 'unknown')
    .map((check) => ({ capability: check.capability, requirementId: check.id, probe: supportsProbe(check.capability), limitation: probeLimitation(check.capability) }));
}
function body(args: unknown): Record<string, unknown> { return record(args); }
/** Return a canonical tool value: the executor validates it against the declared output schema. */
function canonical<T>(value: unknown): T { return value as T; }
function requiredString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || !value.trim()) throw new ReadinessError('INVALID_INTENT', '缺少参数：' + key);
  return value;
}
export async function apply(ctx: PluginContext): Promise<void> {
  const steps = new WeakMap<object, CapturedStep>();
  const lastRoute = new WeakMap<object, string>();
  const modelInfo = new Map<string, ModelInfo>();
  const journal = await openJournal(ctx);
  const probeRunner = createProbeExecutor();
  const readiness = new ReadinessService({
    journal: journal.journal,
    probeSupport: supportsProbe,
    timeoutMs: 30000,
    executeProbe: probeRunner,
    capture: async (intent, context, epoch) => {
      const route: ModelRoute | undefined = context.capturedStep?.modelSelection;
      const info = route ? await modelInfoFor(ctx, route, epoch, modelInfo) : undefined;
      return captureSnapshot(ctx, { agent: context.agent, intent, epoch, signal: context.signal, ...(context.toolSet === undefined ? {} : { toolSet: context.toolSet }), ...(context.capturedStep === undefined ? {} : { capturedStep: context.capturedStep }), ...(info === undefined ? {} : { modelInfo: info }) });
    },
    requestApproval: async (context, reason) => {
      const approval = service<ApprovalPort>(ctx, 'approval');
      if (!approval?.request) return 'unavailable';
      try {
        return await approval.request({ agent: context.agent, toolName: context.toolName, reason, signal: context.signal, ...(context.callId === undefined ? {} : { callId: context.callId }) });
      } catch { return 'unavailable'; }
    },
  });
  listen(ctx, 'agent/pre-step', (payload: { agent: object; turn: number; step: number; modelSelection: ModelRoute }, next: () => Promise<unknown>) => {
    steps.set(payload.agent, { turn: payload.turn, step: payload.step, modelSelection: { provider: payload.modelSelection.provider, model: payload.modelSelection.model } });
    const route = payload.modelSelection.provider + '/' + payload.modelSelection.model;
    const previous = lastRoute.get(payload.agent);
    if (previous !== undefined && previous !== route) readiness.invalidate();
    lastRoute.set(payload.agent, route);
    return next();
  });
  listen(ctx, 'agent/disposed', (payload: { agent?: { id?: string } }) => {
    const id = payload.agent?.id;
    if (typeof id === 'string' && journal.journal.list(id).some((row) => row.resultAt === undefined)) readiness.invalidate();
  });
  const tools = service<{ register(definition: unknown): () => void }>(ctx, 'tools');
  if (!tools) throw new ReadinessError('TOOL_REGISTRY_UNAVAILABLE', '工具注册服务不可用');
  tools.register(defineTool({
    name: 'readiness_check',
    description: '只读检查当前会话能否开始一项任务：本轮工具准入、模型路由、工作目录、写入边界、文档引擎与 MCP 可见性，给出逐项状态、依据和下一步。不执行任务、不联网测试、不改配置。',
    parameters: CHECK_PARAMETERS,
    output: CHECK_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args: unknown, exec) => {
      const input = body(args);
      const context = contextOf(exec, steps);
      const report = await readiness.check(context, {
        version: 1,
        title: requiredString(input, 'title'),
        requirements: input.requirements,
        ...(input.routes === undefined ? {} : { routes: input.routes }),
        files: Array.isArray(input.files) ? input.files : [],
        ...(typeof input.outputDirectory === 'string' ? { outputDirectory: input.outputDirectory } : {}),
      });
      return canonical({ ...modelReport(report), probeOptions: probeOptions(report), unresolvedActions: journal.journal.list(context.agent.id).filter((row) => row.resultAt === undefined).length });
    },
  }));
  tools.register(defineTool({
    name: 'readiness_probe',
    description: '为报告中的一项能力生成最小探测计划；run 模式先请求宿主确认，只有宿主返回 allowed-once 才执行，超时或取消保留未知结果；cancel 撤回计划。',
    parameters: PLAN_PARAMETERS,
    output: ACTION_OUTPUT,
    isConcurrencySafe: () => false,
    execute: async (args: unknown, exec) => {
      const input = body(args);
      const context = contextOf(exec, steps);
      const mode = typeof input.mode === 'string' ? input.mode : 'plan';
      if (mode === 'cancel') {
        const planId = requiredString(input, 'planId');
        readiness.cancel(context.agent.id, planId);
        return canonical({ status: 'cancelled', planId, note: '已撤回计划；未执行的部分不会补做。' });
      }
      const reportId = requiredString(input, 'reportId');
      const report = readiness.getReport(context.agent.id, reportId);
      const requirementId = requiredString(input, 'requirementId');
      const requirement = report.intent.requirements.find((item) => item.id === requirementId);
      if (!requirement) throw new ReadinessError('INVALID_PLAN', '报告中没有该能力项');
      const plan = readiness.plan(context.agent.id, reportId, { kind: 'probe', probeId: requirement.capability, requirementId });
      const summary = { planId: plan.id, status: plan.status, cost: plan.cost, effects: plan.effects, expiresAt: plan.expiresAt };
      if (mode !== 'run') return canonical({ ...summary, note: '计划已生成，尚未执行；run 会先请求宿主确认。' + probeLimitation(requirement.capability) });
      const result = await readiness.run(context, plan.id);
      return canonical({ ...summary, status: result.receipt.status, receipt: result.receipt, report: modelReport(result.report) });
    },
  }));
  tools.register(defineTool({
    name: 'readiness_remedy',
    description: '为本插件拥有的任务选项生成受控处理计划（输出目录、替代路线、恢复上一版本）；run 模式需要宿主确认，只改本插件自有状态，不改宿主模型、权限或其它插件配置。',
    parameters: REMEDY_PARAMETERS,
    output: ACTION_OUTPUT,
    isConcurrencySafe: () => false,
    execute: async (args: unknown, exec) => {
      const input = body(args);
      const context = contextOf(exec, steps);
      const mode = typeof input.mode === 'string' ? input.mode : 'plan';
      if (mode === 'cancel') {
        const planId = requiredString(input, 'planId');
        readiness.cancel(context.agent.id, planId);
        return canonical({ status: 'cancelled', planId, note: '已撤回计划；未执行的部分不会补做。' });
      }
      const reportId = requiredString(input, 'reportId');
      const actionId = requiredString(input, 'actionId');
      const value = requiredString(input, 'value');
      const expectedOptionsRevision = typeof input.expectedOptionsRevision === 'number' ? input.expectedOptionsRevision : 0;
      const plan = readiness.plan(context.agent.id, reportId, { kind: 'remedy', actionId, value, expectedOptionsRevision });
      const summary = { planId: plan.id, status: plan.status, cost: plan.cost, effects: plan.effects, expiresAt: plan.expiresAt };
      if (mode !== 'run') return canonical({ ...summary, note: '计划已生成，尚未执行；run 会先请求宿主确认。' });
      const result = await readiness.run(context, plan.id);
      return canonical({ ...summary, status: result.receipt.status, receipt: result.receipt, report: modelReport(result.report) });
    },
  }));
  const commands = service<CommandPort>(ctx, 'commands');
  if (commands) {
    commands.register({ name: 'readiness', description: '查看当前会话的就绪检查结果与用法', handler: (invocation) => readinessCommand(readiness, invocation.agent.id, invocation.rawInput) });
    commands.register({ name: 'readiness-list', description: '列出本会话保存的就绪报告', handler: (invocation) => listCommand(readiness, invocation.agent.id) });
    commands.register({ name: 'readiness-refresh', description: '让已保存的报告失效，并说明如何重新检查', handler: () => { readiness.invalidate(); return { kind: 'success' as const, text: '已标记旧证据失效。本入口没有本轮工具准入，请在会话中让模型调用 readiness_check 重新检查当前状态。' }; } });
  }
  ctx.effect?.(() => () => { readiness.dispose(); void journal.close(); });
}
async function modelInfoFor(ctx: HostContext, route: ModelRoute, epoch: number, cache: Map<string, ModelInfo>): Promise<ModelInfo | undefined> {
  const key = route.provider + '\u0000' + route.model;
  const cached = cache.get(key);
  if (cached && cached.epoch === epoch) return cached;
  const llm = service<LlmPort>(ctx, 'llm');
  if (!llm?.resolveModelInfo) return undefined;
  try {
    const info = await llm.resolveModelInfo(route);
    if (!info || !Array.isArray(info.inputModalities)) return undefined;
    const entry: ModelInfo = { provider: route.provider, model: route.model, inputModalities: [...info.inputModalities], epoch };
    cache.set(key, entry);
    return entry;
  } catch { return undefined; }
}
function readinessCommand(readiness: ReadinessService, sessionId: string | undefined, rawInput: string): CommandResultLike {
  if (!sessionId) return { kind: 'error', text: '无法确定当前会话。' };
  const sub = rawInput.trim();
  if (sub === 'list') return listCommand(readiness, sessionId);
  if (sub === 'refresh') { readiness.invalidate(); return { kind: 'success', text: '已标记旧证据失效。请在会话中让模型调用 readiness_check 重新检查。' }; }
  const latest = readiness.list(sessionId)[0];
  const lines = ['功能体检助手：在会话中让模型调用 readiness_check 检查当前会话；/readiness-list 查看已保存报告。'];
  if (latest) lines.push('最近一次：' + latest.generatedAt + '，状态 ' + STATUS_LABELS[latest.status] + '，报告 ' + latest.id);
  lines.push('本入口没有本轮工具准入与审批，因此不发起探测、不改配置。');
  return { kind: 'success', text: lines.join('\n') };
}
function listCommand(readiness: ReadinessService, sessionId: string | undefined): CommandResultLike {
  if (!sessionId) return { kind: 'error', text: '无法确定当前会话。' };
  const reports = readiness.list(sessionId);
  if (!reports.length) return { kind: 'success', text: '本会话还没有就绪报告；让模型调用 readiness_check 生成。' };
  return { kind: 'success', text: reports.map((report) => report.generatedAt + ' ' + STATUS_LABELS[report.status] + ' ' + report.id).join('\n') };
}
