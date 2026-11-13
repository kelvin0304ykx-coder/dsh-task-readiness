import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { apply, name as pluginName } from '../src/index.ts';
import type { JournalRecord } from '../src/core/journal.ts';
function memoryTable() {
  const rows = new Map<string, JournalRecord>();
  return { get: (key: string) => rows.get(key), put: async (key: string, value: JournalRecord) => { rows.set(key, value); }, delete: async (key: string) => rows.delete(key), entries: () => rows.entries(), get size() { return rows.size; } };
}
function host(options: { storage?: boolean } = {}) {
  const registered = new Map<string, () => void>();
  const closed: number[] = [];
  const root = new Context();
  const tools = {
    register(definition: { name: string }) { const disposer = () => registered.delete(definition.name); registered.set(definition.name, disposer); return disposer; },
    schemas: () => [],
  };
  root.provide('tools', tools);
  if (options.storage !== false) {
    root.provide('storageDomain', { open: async () => ({ table: () => memoryTable(), close: async () => { closed.push(Date.now()); } }) });
  }
  return { root, registered, closed };
}
test('the plugin mounts and unmounts inside a real Cordis context', async () => {
  const f = host();
  const fiber = f.root.plugin({ name: pluginName, inject: ['tools'], apply: apply as never });
  await fiber;
  assert.deepEqual([...f.registered.keys()].sort(), ['readiness_check', 'readiness_probe', 'readiness_remedy']);
  await fiber.dispose();
  assert.equal(f.closed.length, 1, 'the durable journal must be closed exactly once on unload');
});
test('a host without durable storage still mounts and unmounts', async () => {
  const f = host({ storage: false });
  const fiber = f.root.plugin({ name: pluginName, inject: ['tools'], apply: apply as never });
  await fiber;
  assert.equal(f.registered.size, 3);
  await fiber.dispose();
  assert.equal(f.closed.length, 0);
});
