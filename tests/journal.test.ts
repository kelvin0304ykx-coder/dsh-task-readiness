import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableJournal } from '../src/core/journal.ts';
import type { JournalRecord } from '../src/core/journal.ts';
const now = Date.parse('2026-11-13T10:00:00Z');
const at = new Date(now).toISOString();
const binding = 'a'.repeat(64);
function table() {
  const rows = new Map<string, JournalRecord>();
  const writes: string[] = [];
  return { rows, writes, get: (key: string) => rows.get(key), put: async (key: string, value: JournalRecord) => { writes.push(key); rows.set(key, value); }, delete: async (key: string) => rows.delete(key), entries: () => rows.entries(), keys: () => rows.keys(), get size() { return rows.size; } };
}
const intent = { type: 'intent' as const, planId: 'action-1', sessionId: 'session-a', at, action: 'probe' as const, binding };
const result = { type: 'result' as const, planId: 'action-1', sessionId: 'session-a', at, action: 'probe' as const, binding, status: 'succeeded' as const, code: 'PROBE_PASSED' as const };
test('an intent is durable before any result and stays pending', async () => {
  const t = table();
  const journal = new DurableJournal({ table: t, clock: () => now });
  await journal.record(intent);
  assert.deepEqual(t.writes, ['action-1']);
  assert.equal(journal.pending('session-a').length, 1);
  assert.equal(journal.list('session-a')[0].status, undefined);
});
test('a result settles the pending intent without losing its intent time', async () => {
  const t = table();
  const journal = new DurableJournal({ table: t, clock: () => now });
  await journal.record(intent);
  await journal.record(result);
  const [record] = journal.list('session-a');
  assert.equal(record.status, 'succeeded');
  assert.equal(record.code, 'PROBE_PASSED');
  assert.equal(record.intentAt, at);
  assert.equal(journal.pending('session-a').length, 0);
});
test('a result without a prior intent is still journaled instead of dropped', async () => {
  const t = table();
  const journal = new DurableJournal({ table: t, clock: () => now });
  await journal.record(result);
  const [record] = journal.list('session-a');
  assert.equal(record.status, 'succeeded');
  assert.equal(record.intentAt, at);
});
test('journals are session-scoped', async () => {
  const t = table();
  const journal = new DurableJournal({ table: t, clock: () => now });
  await journal.record(intent);
  await journal.record({ ...intent, planId: 'action-2', sessionId: 'session-b' });
  assert.equal(journal.list('session-a').length, 1);
  assert.equal(journal.list('session-b').length, 1);
  assert.throws(() => journal.list(''), { code: 'AGENT_REQUIRED' });
});
test('the journal stores identifiers and outcomes only, never task text or paths', async () => {
  const t = table();
  const journal = new DurableJournal({ table: t, clock: () => now });
  await journal.record(intent);
  await journal.record(result);
  const stored = [...t.rows.values()][0];
  assert.deepEqual(Object.keys(stored).sort(), ['action', 'binding', 'code', 'intentAt', 'planId', 'resultAt', 'sessionId', 'status']);
  const text = JSON.stringify(stored);
  assert.ok(!text.includes('/private'));
  assert.ok(!text.includes('confidential'));
});
test('malformed events are rejected before reaching the store', async () => {
  const t = table();
  const journal = new DurableJournal({ table: t, clock: () => now });
  for (const bad of [{ ...intent, planId: '' }, { ...intent, binding: 'short' }, { ...intent, action: 'shell' }, { ...result, status: 'maybe' }, { ...intent, at: 'yesterday' }]) {
    await assert.rejects(journal.record(bad as never), { code: 'INVALID_JOURNAL_EVENT' });
  }
  assert.equal(t.writes.length, 0);
});
test('the journal is bounded and evicts the oldest settled record first', async () => {
  let clock = now;
  const t = table();
  const journal = new DurableJournal({ table: t, clock: () => clock, limit: 2 });
  await journal.record(intent);
  await journal.record({ ...result, at: new Date(clock += 1000).toISOString() });
  await journal.record({ ...intent, planId: 'action-2', at: new Date(clock += 1000).toISOString() });
  await journal.record({ ...intent, planId: 'action-3', at: new Date(clock += 1000).toISOString() });
  assert.equal(journal.list('session-a').length, 2);
  assert.ok(!journal.list('session-a').some((r) => r.planId === 'action-1'));
  assert.ok(journal.pending('session-a').every((r) => r.resultAt === undefined));
});
test('a store failure surfaces instead of pretending the intent was recorded', async () => {
  const t = table();
  t.put = async () => { throw new Error('disk full'); };
  const journal = new DurableJournal({ table: t, clock: () => now });
  await assert.rejects(journal.record(intent));
});
