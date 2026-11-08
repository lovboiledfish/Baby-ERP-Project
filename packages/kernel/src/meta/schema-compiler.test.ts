import { describe, expect, it } from 'vitest';
import { indexName, planDDL } from './schema-compiler';

describe('planDDL', () => {
  it('creates a physical table with system columns for a root table', () => {
    const [create, index] = planDDL({ kind: 'add_table', table: 'task' });
    expect(create).toMatch(/^CREATE TABLE "task" \(/);
    for (const col of ['sys_id', 'sys_class_name', 'sys_created_on', 'sys_created_by', 'sys_updated_on', 'sys_updated_by', 'sys_mod_count', 'sys_scope']) {
      expect(create).toContain(`"${col}"`);
    }
    expect(create).toContain('"sys_id" uuid PRIMARY KEY');
    expect(index).toBe('CREATE INDEX "task_sys_class_name_idx" ON "task" ("sys_class_name")');
  });

  it('creates no storage for a child table (table-per-hierarchy)', () => {
    expect(planDDL({ kind: 'add_table', table: 'incident', superClass: 'task' })).toEqual([]);
  });

  it('adds typed columns to the physical table', () => {
    expect(planDDL({ kind: 'add_field', physical: 'task', column: 'priority', type: 'integer' })).toEqual([
      'ALTER TABLE "task" ADD COLUMN "priority" integer',
    ]);
    expect(planDDL({ kind: 'add_field', physical: 'task', column: 'opened_at', type: 'datetime' })).toEqual([
      'ALTER TABLE "task" ADD COLUMN "opened_at" timestamptz',
    ]);
    expect(planDDL({ kind: 'add_field', physical: 'task', column: 'meta', type: 'json' })).toEqual([
      'ALTER TABLE "task" ADD COLUMN "meta" jsonb',
    ]);
  });

  it('indexes reference columns', () => {
    expect(planDDL({ kind: 'add_field', physical: 'task', column: 'caller', type: 'reference' })).toEqual([
      'ALTER TABLE "task" ADD COLUMN "caller" uuid',
      'CREATE INDEX "task_caller_idx" ON "task" ("caller")',
    ]);
  });

  it('creates unique indexes', () => {
    expect(planDDL({ kind: 'add_unique', physical: 'sys_dictionary', columns: ['name', 'element'] })).toEqual([
      'CREATE UNIQUE INDEX "sys_dictionary_name_element_uniq" ON "sys_dictionary" ("name", "element")',
    ]);
  });

  it('refuses unsafe identifiers', () => {
    expect(() => planDDL({ kind: 'add_table', table: 'task"; DROP TABLE x; --' })).toThrow(/Unsafe SQL identifier/);
    expect(() => planDDL({ kind: 'add_field', physical: 'task', column: 'Bad', type: 'string' })).toThrow();
  });

  it('keeps index names within the Postgres 63 character limit', () => {
    const name = indexName('a_very_long_table_name_for_testing_purposes', ['a_very_long_column_name_too'], 'idx');
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toBe(indexName('a_very_long_table_name_for_testing_purposes', ['a_very_long_column_name_too'], 'idx'));
  });
});
