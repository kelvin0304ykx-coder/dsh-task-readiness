import z from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { DurableJournal } from '../core/journal.ts';
import type { JournalRecord, JournalTable } from '../core/journal.ts';
const OUTCOME_STATUS = ['succeeded', 'failed', 'cancelled', 'outcome_unknown'] as const;
const OUTCOME_CODE = ['PROBE_PASSED', 'PROBE_FAILED', 'PROBE_CANCELLED', 'PROBE_UNSUPPORTED', 'OUTCOME_UNKNOWN', 'NOT_SUPPORTED', 'OPTIONS_UPDATED', 'OPTIONS_RESTORED', 'JOURNAL_FAILED'] as const;
const recordSchema = z.strictObject({
  planId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), action: z.enum(['probe', 'remedy']),
  binding: z.string().regex(/^[a-f0-9]{64}$/), intentAt: z.string().min(1).max(64),
  resultAt: z.string().min(1).max(64).optional(), status: z.enum(OUTCOME_STATUS).optional(), code: z.enum(OUTCOME_CODE).optional(),
});
/** Durable action journal owned by this plugin; records identifiers and outcomes only. */
export const journalDomain = defineDomain({ name: 'task_readiness', version: 1, layout: 'per-record', tables: { journal: domainTable<string, JournalRecord>(recordSchema) } });
interface JournalDomain { table(name: 'journal'): JournalTable; close(): Promise<void> }
export interface JournalFacility { open(spec: typeof journalDomain): Promise<JournalDomain> }
export interface OpenedJournal { journal: DurableJournal; close(): Promise<void> }
/** Open the journal and return the disposer the plugin must call on unload. */
export async function openDurableJournal(facility: JournalFacility, options: { limit?: number } = {}): Promise<OpenedJournal> {
  const domain = await facility.open(journalDomain);
  return { journal: new DurableJournal({ table: domain.table('journal'), ...options }), close: () => domain.close() };
}
