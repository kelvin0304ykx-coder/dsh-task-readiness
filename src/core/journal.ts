import { ReadinessError } from './types.ts';
import type { ActionJournal, JournalEvent, OutcomeCode, OutcomeStatus } from './actions.ts';
/** The single durable record per action plan; identifiers and outcomes only. */
export interface JournalRecord {
  planId: string; sessionId: string; action: 'probe' | 'remedy'; binding: string; intentAt: string;
  resultAt?: string; status?: OutcomeStatus; code?: OutcomeCode;
}
export interface JournalTable {
  get(key: string): JournalRecord | undefined;
  put(key: string, value: JournalRecord): Promise<void>;
  delete(key: string): Promise<boolean>;
  entries(): IterableIterator<[string, JournalRecord]>;
  readonly size: number;
}
const STATUSES: readonly OutcomeStatus[] = ['succeeded', 'failed', 'cancelled', 'outcome_unknown'];
const CODES: readonly OutcomeCode[] = ['PROBE_PASSED', 'PROBE_FAILED', 'PROBE_CANCELLED', 'PROBE_UNSUPPORTED', 'OUTCOME_UNKNOWN', 'NOT_SUPPORTED', 'OPTIONS_UPDATED', 'OPTIONS_RESTORED', 'JOURNAL_FAILED'];
const IDENTIFIER = /^[A-Za-z0-9:_-]{1,200}$/;
const BINDING = /^[a-f0-9]{64}$/;
function reject(): never { throw new ReadinessError('INVALID_JOURNAL_EVENT', 'INVALID_JOURNAL_EVENT'); }
function isAt(value: unknown): value is string { return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)); }
function checked(event: JournalEvent): JournalEvent {
  const candidate = event as Partial<JournalEvent> | null;
  if (candidate === null || typeof candidate !== 'object') reject();
  if (candidate.type !== 'intent' && candidate.type !== 'result') reject();
  if (typeof candidate.planId !== 'string' || !IDENTIFIER.test(candidate.planId)) reject();
  if (typeof candidate.sessionId !== 'string' || !IDENTIFIER.test(candidate.sessionId)) reject();
  if (candidate.action !== 'probe' && candidate.action !== 'remedy') reject();
  if (typeof candidate.binding !== 'string' || !BINDING.test(candidate.binding)) reject();
  if (!isAt(candidate.at)) reject();
  if (candidate.type === 'result') {
    if (!STATUSES.includes(candidate.status as OutcomeStatus)) reject();
    if (!CODES.includes(candidate.code as OutcomeCode)) reject();
  }
  return candidate as JournalEvent;
}
/**
 * Journal over a host storage table. The intent is written before any effect
 * and the result after it, so an interrupted run stays visibly unresolved
 * instead of being reported as either success or absence.
 */
export class DurableJournal implements ActionJournal {
  private readonly table: JournalTable;
  private readonly limit: number;
  constructor(options: { table: JournalTable; limit?: number }) {
    this.table = options.table;
    this.limit = options.limit ?? 500;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 10000) reject();
  }
  async record(raw: JournalEvent): Promise<void> {
    const event = checked(raw);
    const existing = this.table.get(event.planId);
    const record: JournalRecord = {
      planId: event.planId, sessionId: event.sessionId, action: event.action, binding: event.binding,
      intentAt: existing?.intentAt ?? event.at, ...(existing?.resultAt === undefined ? {} : { resultAt: existing.resultAt }), ...(existing?.status === undefined ? {} : { status: existing.status }), ...(existing?.code === undefined ? {} : { code: existing.code }),
    };
    if (event.type === 'result') {
      if (event.status !== undefined) record.status = event.status;
      if (event.code !== undefined) record.code = event.code;
      record.resultAt = event.at;
    }
    if (existing === undefined && this.table.size >= this.limit) await this.evict();
    await this.table.put(event.planId, record);
  }
  list(sessionId: string): JournalRecord[] {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new ReadinessError('AGENT_REQUIRED', 'AGENT_REQUIRED');
    const rows: JournalRecord[] = [];
    for (const [, record] of this.table.entries()) if (record.sessionId === sessionId) rows.push({ ...record });
    return rows.sort((a, b) => Date.parse(a.intentAt) - Date.parse(b.intentAt) || a.planId.localeCompare(b.planId));
  }
  /** Actions whose result was never recorded; the user decides, not the plugin. */
  pending(sessionId: string): JournalRecord[] { return this.list(sessionId).filter((record) => record.resultAt === undefined); }
  private async evict(): Promise<void> {
    let victim: JournalRecord | undefined;
    for (const [, record] of this.table.entries()) {
      if (record.resultAt === undefined) continue;
      if (victim === undefined || Date.parse(record.resultAt) < Date.parse(victim.resultAt ?? '') || (record.resultAt === victim.resultAt && record.planId < victim.planId)) victim = record;
    }
    if (victim === undefined) throw new ReadinessError('JOURNAL_FULL', 'JOURNAL_FULL');
    await this.table.delete(victim.planId);
  }
}
