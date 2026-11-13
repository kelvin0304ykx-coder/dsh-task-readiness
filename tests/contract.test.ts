import test from 'node:test';
import assert from 'node:assert/strict';
import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ReadinessService } from '../src/host/service.ts';
import { createTools } from '../src/host/tools.ts';
import { journalDomain } from '../src/host/journal-domain.ts';
import { CAPABILITIES } from '../src/core/types.ts';
import { TEMPLATE_IDS } from '../src/core/intent.ts';
const deps = { readiness: {} as ReadinessService, journal: { list: () => [] }, steps: new WeakMap() };
const definitions: readonly ToolDefinition[] = createTools(deps);
test('the tool definitions are assignable to the host ToolDefinition contract', () => {
  assert.equal(definitions.length, 3);
  for (const definition of definitions) {
    assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(typeof definition.output.schema, 'object');
    assert.equal(definition.parameters.type, 'object');
  }
});
test('the parameter schemas declare required fields and closed nested objects', () => {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const check = byName.get('readiness_check')!;
  assert.ok(check.parameters.properties?.requirements);
  assert.ok(check.parameters.properties?.template?.enum?.includes('images'));
  const requirement = check.parameters.properties?.requirements?.items;
  assert.equal(requirement?.type, 'object');
  assert.equal(requirement?.additionalProperties, false);
  assert.deepEqual(requirement?.required, ['id', 'capability']);
  assert.deepEqual([...(requirement?.properties?.capability?.enum ?? [])].sort(), [...CAPABILITIES].sort());
  assert.deepEqual([...(check.parameters.properties?.template?.enum ?? [])].sort(), [...TEMPLATE_IDS].sort());
  const probe = byName.get('readiness_probe')!;
  assert.deepEqual([...(probe.parameters.required ?? [])].sort(), ['reportId', 'requirementId']);
  const remedy = byName.get('readiness_remedy')!;
  assert.deepEqual([...(remedy.parameters.required ?? [])].sort(), ['actionId', 'expectedOptionsRevision', 'reportId', 'value']);
});
test('the output schemas stay inside the host JSON Schema subset', () => {
  const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'oneOf']);
  const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  const walk = (node: unknown, path: string) => {
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) assert.ok(allowed.has(key), path + '.' + key + ' is outside the enforced subset');
    if (typeof record.type === 'string') assert.ok(types.has(record.type), path + '.type ' + record.type);
    for (const [name, child] of Object.entries((record.properties ?? {}) as Record<string, unknown>)) walk(child, path + '.' + name);
    if (record.items) walk(record.items, path + '[]');
  };
  for (const definition of definitions) walk(definition.output.schema, definition.name + '.output');
});
test('the journal domain declaration is accepted by the host defineDomain', () => {
  const domain = defineDomain(journalDomain as never);
  assert.equal(domain.name, 'task_readiness');
  assert.equal(domain.tables.journal !== undefined, true);
});
