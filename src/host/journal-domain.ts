import z from 'zod';
import { DurableJournal } from '../core/journal.ts';
import type { JournalTable } from '../core/journal.ts';
import { ReadinessError } from '../core/types.ts';
const OUTCOME_STATUS = ['succeeded', 'failed', 'cancelled', 'outcome_unknown'] as const;
const OUTCOME_CODE = ['PROBE_PASSED', 'PROBE_FAILED', 'PROBE_CANCELLED', 'PROBE_UNSUPPORTED', 'OUTCOME_UNKNOWN', 'NOT_SUPPORTED', 'OPTIONS_UPDATED', 'OPTIONS_RESTORED', 'JOURNAL_FAILED'] as const;
const NAME = /^[a-z][a-z0-9_]*$/;
const DOMAIN_NAME = 'task_readiness';
const recordSchema = z.strictObject({
  planId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), action: z.enum(['probe', 'remedy']),
  binding: z.string().regex(/^[a-f0-9]{64}$/), intentAt: z.string().min(1).max(64),
  resultAt: z.string().min(1).max(64).optional(), status: z.enum(OUTCOME_STATUS).optional(), code: z.enum(OUTCOME_CODE).optional(),
});
/**
 * Durable action journal owned by this plugin. Declared locally so the plugin has
 * no runtime import from a host package; the host validates the declaration when
 * the domain is opened, and the shape is kept equivalent to `defineDomain`.
 */
export const journalDomain = { name: DOMAIN_NAME, version: 1, layout: 'per-record' as const, tables: { journal: { valueSchema: recordSchema } } };
if (!NAME.test(journalDomain.name)) throw new ReadinessError('INVALID_JOURNAL_DOMAIN', 'journal domain name must match the host pattern');
if (!Number.isInteger(journalDomain.version) || journalDomain.version < 0) throw new ReadinessError('INVALID_JOURNAL_DOMAIN', 'journal domain version must be a non-negative integer');
for (const table of Object.keys(journalDomain.tables)) if (!NAME.test(table)) throw new ReadinessError('INVALID_JOURNAL_DOMAIN', 'journal table name must match the host pattern');
interface JournalDomain { table(name: 'journal'): JournalTable; close(): Promise<void> }
export interface JournalFacility { open(spec: typeof journalDomain): Promise<JournalDomain> }
export interface OpenedJournal { journal: DurableJournal; close(): Promise<void> }
/** Open the journal and return the disposer the plugin must call on unload. */
export async function openDurableJournal(facility: JournalFacility, options: { limit?: number } = {}): Promise<OpenedJournal> {
  const domain = await facility.open(journalDomain);
  return { journal: new DurableJournal({ table: domain.table('journal'), ...options }), close: () => domain.close() };
}
