import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import type { ActionPlan, ExecutionOutcome } from '../core/actions.ts';
import type { Capability, Report, TaskIntent } from '../core/types.ts';
import type { CheckContext } from './service.ts';
import type { HostContext } from './snapshot.ts';
/** Synthetic fixture marker; probes never read user documents. */
export const PROBE_MARKER = 'DSH-READINESS-PROBE-v1';
/**
 * Capabilities with a real, bounded probe in this build. Everything else keeps
 * the honest `unknown` result and a manual next step instead of a fake test.
 */
export const SUPPORTED_PROBES = ['files.read', 'files.write', 'web.fetch', 'web.search', 'office.convert', 'office.render', 'office.recalculate'] as const;
const SUPPORTED: ReadonlySet<string> = new Set(SUPPORTED_PROBES);
const LIMITATIONS: Record<Capability, string> = {
  'web.search': '内置一次有上限的检索探测；结果只代表这一次查询。',
  'web.fetch': '内置对固定示例页的一次抓取探测；其他站点仍需单独验证。',
  'files.read': '内置对已声明输入的受限读取。',
  'files.write': '内置在所选输出目录创建并立即删除唯一合成文件的写入探测。',
  'image.inspect': '图片理解探测需要新一轮模型请求和图片附件，本插件不代发模型请求；请在会话中直接发一张图片试一小轮。',
  'office.create': '文档生成探测需要宿主 shell 与已加载技能，本插件不代跑脚本；加载 Office 技能后生成一份最小文档即可确认。',
  'office.render': '内置合成文档的页面渲染探测。',
  'office.convert': '内置合成文档的格式转换探测。',
  'office.recalculate': '内置合成工作簿的公式重算探测。',
  'browser.read': '浏览器读取探测需要调用当前会话的浏览器工具，本插件不直接执行工具；请在会话中用 browser 工具打开一个测试页。',
  'mcp.list': 'MCP 探测会连接服务并可能启动进程，本插件不代发；请在宿主设置核对服务器连接状态。',
};
export function supportsProbe(capability: string): capability is (typeof SUPPORTED_PROBES)[number] { return SUPPORTED.has(capability); }
export function probeLimitation(capability: Capability): string { return Object.hasOwn(LIMITATIONS, capability) ? LIMITATIONS[capability] : '本能力没有自动探测。'; }
interface FsTarget { readonly displayPath?: string }
interface FsInfo { type: string; size?: number; version?: unknown }
interface ProbeFs {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>;
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>;
  readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>;
  writeText(target: FsTarget, content: string, expected?: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: unknown }, signal?: AbortSignal, policy?: unknown): Promise<{ version?: unknown }>;
  deleteFile(target: FsTarget, expected?: { version: unknown }, signal?: AbortSignal, policy?: unknown): Promise<unknown>;
}
interface ProbeWeb {
  fetch(request: { url: string }, signal?: AbortSignal): Promise<{ statusCode: number; body?: { kind: string; content: string } } | undefined>;
  search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<{ content?: string; sources?: readonly { url: string }[] } | undefined>;
}
interface OfficeSource { key: string; version: string; bytes?: number; read(signal: AbortSignal, maxBytes: number): Promise<{ bytes: Uint8Array; version: string }> }
interface ProbeOffice {
  convert?(request: { extension: string; priority: string; source: OfficeSource }, signal?: AbortSignal): Promise<{ pdf?: Uint8Array } | undefined>;
  renderImages?(request: { extension: string; source: OfficeSource; dpi?: number; maxImages: number; maxPixels: number; maxDimension: number; maxBytes: number }, signal?: AbortSignal): Promise<{ images?: readonly { png?: Uint8Array }[] } | undefined>;
  recalculate?(request: { extension: string; format: string; source: OfficeSource; output: { owner: string; name: string } }, signal?: AbortSignal): Promise<{ bytes?: number } | undefined>;
}
interface SandboxPolicy { mode?: string; workspaceRoot?: string; additionalWritableRoots?: readonly string[] }
interface DirectoryPort { get(session: unknown): string }
const PASSED: ExecutionOutcome = { status: 'succeeded', code: 'PROBE_PASSED' };
const FAILED: ExecutionOutcome = { status: 'failed', code: 'PROBE_FAILED' };
const CANCELLED: ExecutionOutcome = { status: 'cancelled', code: 'PROBE_CANCELLED' };
const UNKNOWN: ExecutionOutcome = { status: 'outcome_unknown', code: 'OUTCOME_UNKNOWN' };
const UNSUPPORTED: ExecutionOutcome = { status: 'outcome_unknown', code: 'PROBE_UNSUPPORTED' };
const PDF_MAGIC = '%PDF-';
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export interface ProbeLimits { maxImages: number; maxPixels: number; maxDimension: number; maxBytes: number; dpi: number }
export interface ProbeOptions {
  now?: () => number;
  /** Fixed allowlisted page; task text can never supply a probe URL. */
  fetchUrl?: string;
  fetchMarker?: string;
  searchQuery?: string;
  maxSearchResults?: number;
  maxReadBytes?: number;
  loadAsset?: (name: 'docx' | 'xlsx') => Promise<Uint8Array>;
  officeLimits?: ProbeLimits;
}
export type ProbeRunner = (context: CheckContext, plan: ActionPlan, report: Report, signal: AbortSignal) => Promise<ExecutionOutcome>;
function port<T>(host: HostContext | undefined, name: string): T | undefined {
  try { const value = typeof host?.get === 'function' ? host.get(name) : host?.[name]; return value as T | undefined; } catch { return undefined; }
}
function decode(bytes: Uint8Array): string { return Buffer.from(bytes).toString('utf8'); }
function hasPrefix(bytes: Uint8Array, prefix: string): boolean { return bytes.length >= prefix.length && decode(bytes.slice(0, prefix.length)) === prefix; }
function isPng(bytes: Uint8Array): boolean { return PNG_MAGIC.every((value, index) => bytes[index] === value); }
/**
 * Package root resolved from this module's own location, so the same source works
 * unbundled (src/host) and bundled (lib). No environment variable or cwd involved.
 */
function packageRoot(): URL {
  let directory = new URL('.', import.meta.url);
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      readFileSync(new URL('package.json', directory));
      return directory;
    } catch { directory = new URL('../', directory); }
  }
  return new URL('../', import.meta.url);
}
async function defaultLoadAsset(name: 'docx' | 'xlsx'): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL('assets/probe.' + name, packageRoot())));
}
function assetSource(name: string, bytes: Uint8Array): OfficeSource {
  const version = PROBE_MARKER + ':' + name;
  return { key: 'readiness-probe/' + name, version, bytes: bytes.length, read: async () => ({ bytes, version }) };
}
function processCwd(host: HostContext | undefined, context: CheckContext): string | undefined {
  try { const directory = port<DirectoryPort>(host, 'workingDirectory'); return directory?.get(context.agent.session); } catch { return undefined; }
}
async function convertPdf(office: ProbeOffice, bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array | undefined> {
  if (!office.convert) return undefined;
  const result = await office.convert({ extension: 'docx', priority: 'foreground', source: assetSource('docx', bytes) }, signal);
  const pdf = result?.pdf;
  if (!(pdf instanceof Uint8Array) || !hasPrefix(pdf, PDF_MAGIC)) return undefined;
  return pdf;
}
/**
 * Build the one probe runner the plugin registers. Every branch reads only
 * authorized host services, bounded synthetic input, and a fixed external
 * target; task text never supplies a URL, query, path or command.
 */
export function createProbeExecutor(options: ProbeOptions = {}): ProbeRunner {
  const now = options.now ?? Date.now;
  const fetchUrl = options.fetchUrl ?? 'https://example.com/';
  const fetchMarker = options.fetchMarker ?? 'Example Domain';
  const searchQuery = options.searchQuery ?? 'DeepSeek Harness task readiness check';
  const maxSearchResults = Math.min(Math.max(options.maxSearchResults ?? 2, 1), 3);
  const maxReadBytes = Math.min(Math.max(options.maxReadBytes ?? 4096, 1), 65536);
  const loadAsset = options.loadAsset ?? defaultLoadAsset;
  const officeLimits: ProbeLimits = { maxImages: 2, maxPixels: 640000, maxDimension: 1024, maxBytes: 2000000, dpi: 72, ...options.officeLimits };
  return async function executeProbe(context, plan, report, signal) {
    const request = plan?.request;
    if (!request || request.kind !== 'probe' || !supportsProbe(request.probeId)) return { ...UNSUPPORTED };
    const live = signal ?? context.signal;
    if (!live || live.aborted) return { ...CANCELLED };
    const host = context.agent?.ctx;
    try {
      const outcome = await run(request.probeId, { host, context, report, live, now, fetchUrl, fetchMarker, searchQuery, maxSearchResults, maxReadBytes, loadAsset, officeLimits });
      return outcome;
    } catch {
      return live.aborted || context.signal?.aborted ? { ...CANCELLED } : { ...FAILED };
    }
  };
}
interface RunInput { host: HostContext | undefined; context: CheckContext; report: Report; live: AbortSignal; now: () => number; fetchUrl: string; fetchMarker: string; searchQuery: string; maxSearchResults: number; maxReadBytes: number; loadAsset: (name: 'docx' | 'xlsx') => Promise<Uint8Array>; officeLimits: ProbeLimits }
async function run(capability: (typeof SUPPORTED_PROBES)[number], input: RunInput): Promise<ExecutionOutcome> {
  const intent: TaskIntent = input.report.intent;
  switch (capability) {
    case 'files.read': return readInputs(input, intent);
    case 'files.write': return writeOutput(input, intent);
    case 'web.fetch': return fetchPage(input);
    case 'web.search': return searchOnce(input);
    case 'office.convert': return officeConvert(input);
    case 'office.render': return officeRender(input);
    case 'office.recalculate': return officeRecalculate(input);
  }
}
async function readInputs(input: RunInput, intent: TaskIntent): Promise<ExecutionOutcome> {
  if (!intent.files.length) return { ...FAILED };
  const fs = port<ProbeFs>(input.host, 'fs');
  if (!fs) return { ...FAILED };
  const cwd = processCwd(input.host, input.context);
  for (const path of intent.files) {
    const target = await fs.resolve(path, { cwd, signal: input.live });
    input.live.throwIfAborted();
    const info = await fs.stat(target, input.live);
    if (!info || info.type !== 'file') return { ...FAILED };
    const window = await fs.readByteRange(target, { offset: 0, length: input.maxReadBytes }, input.live);
    if (!(window instanceof Uint8Array)) return { ...FAILED };
  }
  return { ...PASSED };
}
async function writeOutput(input: RunInput, intent: TaskIntent): Promise<ExecutionOutcome> {
  const fs = port<ProbeFs>(input.host, 'fs');
  const policy = port<{ resolve(scope: { session: unknown }): SandboxPolicy }>(input.host, 'sandboxPolicy');
  if (!fs || !policy) return { ...FAILED };
  let resolved: SandboxPolicy;
  try { resolved = policy.resolve({ session: input.context.agent.session }); } catch { return { ...FAILED }; }
  if (resolved.mode !== 'workspace-write' && resolved.mode !== 'danger-full-access') return { ...FAILED };
  if (!intent.outputDirectory) return { ...FAILED };
  const cwd = processCwd(input.host, input.context);
  const directory = intent.outputDirectory.replace(/\/+$/, '') || '/';
  const name = '.dsh-readiness-probe-' + randomBytes(8).toString('hex') + '.txt';
  const target = await fs.resolve(directory + '/' + name, { cwd, signal: input.live });
  input.live.throwIfAborted();
  const content = PROBE_MARKER + ' ' + new Date(input.now()).toISOString() + '\n';
  const written = await fs.writeText(target, content, { kind: 'createIfAbsent' }, input.live, resolved);
  let verified = false;
  try { const window = await fs.readByteRange(target, { offset: 0, length: content.length }, input.live); verified = decode(window) === content; } catch { verified = false; }
  let cleaned = false;
  try { await fs.deleteFile(target, written?.version === undefined ? undefined : { version: written.version }, input.live, resolved); cleaned = true; } catch { cleaned = false; }
  if (!cleaned) return { ...UNKNOWN };
  return verified ? { ...PASSED } : { ...FAILED };
}
async function fetchPage(input: RunInput): Promise<ExecutionOutcome> {
  const web = port<ProbeWeb>(input.host, 'web');
  if (!web || typeof web.fetch !== 'function') return { ...FAILED };
  const result = await web.fetch({ url: input.fetchUrl }, input.live);
  if (!result || typeof result.statusCode !== 'number') return { ...FAILED };
  if (result.statusCode < 200 || result.statusCode > 299) return { ...FAILED };
  const body = result.body;
  if (!body || typeof body.content !== 'string') return { ...FAILED };
  return body.content.includes(input.fetchMarker) ? { ...PASSED } : { ...FAILED };
}
async function searchOnce(input: RunInput): Promise<ExecutionOutcome> {
  const web = port<ProbeWeb>(input.host, 'web');
  if (!web || typeof web.search !== 'function') return { ...FAILED };
  const result = await web.search({ query: input.searchQuery, maxResults: input.maxSearchResults }, input.live);
  if (!result) return { ...FAILED };
  const sources = Array.isArray(result.sources) ? result.sources : [];
  if (sources.length > 0) return { ...PASSED };
  return typeof result.content === 'string' && result.content.trim().length > 0 ? { ...PASSED } : { ...FAILED };
}
async function officeConvert(input: RunInput): Promise<ExecutionOutcome> {
  const office = port<ProbeOffice>(input.host, 'officeKit');
  if (!office || typeof office.convert !== 'function') return { ...FAILED };
  const bytes = await input.loadAsset('docx');
  return (await convertPdf(office, bytes, input.live)) ? { ...PASSED } : { ...FAILED };
}
async function officeRender(input: RunInput): Promise<ExecutionOutcome> {
  const office = port<ProbeOffice>(input.host, 'officeKit');
  if (!office || typeof office.convert !== 'function' || typeof office.renderImages !== 'function') return { ...FAILED };
  const bytes = await input.loadAsset('docx');
  const pdf = await convertPdf(office, bytes, input.live);
  if (!pdf) return { ...FAILED };
  const limits = input.officeLimits;
  const result = await office.renderImages({ extension: 'pdf', source: assetSource('pdf', pdf), dpi: limits.dpi, maxImages: limits.maxImages, maxPixels: limits.maxPixels, maxDimension: limits.maxDimension, maxBytes: limits.maxBytes }, input.live);
  const images = Array.isArray(result?.images) ? result!.images : [];
  const first = images[0]?.png;
  return first instanceof Uint8Array && isPng(first) ? { ...PASSED } : { ...FAILED };
}
async function officeRecalculate(input: RunInput): Promise<ExecutionOutcome> {
  const office = port<ProbeOffice>(input.host, 'officeKit');
  if (!office || typeof office.recalculate !== 'function') return { ...FAILED };
  const bytes = await input.loadAsset('xlsx');
  const result = await office.recalculate({ extension: 'xlsx', format: 'xlsx', source: assetSource('xlsx', bytes), output: { owner: input.context.agent.id, name: 'readiness-probe.xlsx' } }, input.live);
  return typeof result?.bytes === 'number' && result.bytes > 0 ? { ...PASSED } : { ...FAILED };
}
