import type { ActionJournal, JournalEvent } from './core/actions.ts';
import type { JournalRecord } from './core/journal.ts';
import { STATUS_LABELS } from './core/messages.ts';
import { ReadinessError } from './core/types.ts';
import type { ModelRoute } from './core/types.ts';
import { openDurableJournal } from './host/journal-domain.ts';
import type { JournalFacility } from './host/journal-domain.ts';
import { createProbeExecutor, supportsProbe } from './host/probes.ts';
import { ReadinessService } from './host/service.ts';
import { captureSnapshot } from './host/snapshot.ts';
import type { CapturedStep, HostContext, ModelInfo } from './host/snapshot.ts';
import { createTools } from './host/tools.ts';
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
function service<T>(ctx: HostContext, key: string): T | undefined { try { return (typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]) as T | undefined; } catch { return undefined; } }
function listen(ctx: PluginContext, event: string, handler: (...args: never[]) => unknown): void {
  const register = (ctx as { on?: (name: string, listener: (...args: unknown[]) => unknown) => unknown }).on;
  if (typeof register === 'function') register.call(ctx, event, handler as (...args: unknown[]) => unknown);
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
export async function apply(ctx: PluginContext): Promise<void> {
  const steps = new WeakMap<object, CapturedStep>();
  const lastRoute = new WeakMap<object, string>();
  const modelInfo = new Map<string, ModelInfo>();
  const journal = await openJournal(ctx);
  const readiness = new ReadinessService({
    journal: journal.journal,
    probeSupport: supportsProbe,
    /** A cold document engine can take tens of seconds; cancellation still works through the signal. */
    timeoutMs: 60000,
    executeProbe: createProbeExecutor(),
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
  for (const definition of createTools({ readiness, journal: { list: (sessionId: string) => journal.journal.list(sessionId) }, steps })) tools.register(definition);
  const commands = service<CommandPort>(ctx, 'commands');
  if (commands) {
    commands.register({ name: 'readiness', description: '查看当前会话的就绪检查结果与用法', handler: (invocation) => readinessCommand(readiness, invocation.agent.id, invocation.rawInput) });
    commands.register({ name: 'readiness-list', description: '列出本会话保存的就绪报告', handler: (invocation) => listCommand(readiness, invocation.agent.id) });
    commands.register({ name: 'readiness-refresh', description: '让已保存的报告失效，并说明如何重新检查', handler: () => { readiness.invalidate(); return { kind: 'success' as const, text: '已标记旧证据失效。本入口没有本轮工具准入，请在会话中让模型调用 readiness_check 重新检查当前状态。' }; } });
  }
  ctx.effect?.(() => () => { readiness.dispose(); void journal.close(); });
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
