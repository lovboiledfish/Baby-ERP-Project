import type { FieldType } from '@steward/shared';
import { quoteIdent, shortHash } from '../util';

/**
 * Pure translation of dictionary changes into DDL.
 *
 * Storage model: table-per-hierarchy. Only root tables get a physical table;
 * child tables add their columns to the root's table and are distinguished by
 * the sys_class_name discriminator column.
 */
export type DictionaryChange =
  | { kind: 'add_table'; table: string; superClass?: string | null }
  | { kind: 'add_field'; physical: string; column: string; type: FieldType }
  | { kind: 'add_unique'; physical: string; columns: string[] }
  | { kind: 'add_index'; physical: string; columns: string[] };

const PG_TYPES: Record<FieldType, string> = {
  string: 'text',
  text: 'text',
  script: 'text',
  password: 'text',
  journal: 'text',
  choice: 'text',
  sys_class_name: 'text',
  integer: 'integer',
  decimal: 'numeric',
  boolean: 'boolean',
  date: 'date',
  datetime: 'timestamptz',
  reference: 'uuid',
  guid: 'uuid',
  json: 'jsonb',
};

export function pgType(type: FieldType): string {
  return PG_TYPES[type];
}

export function indexName(physical: string, columns: string[], suffix: string): string {
  const name = `${physical}_${columns.join('_')}_${suffix}`;
  return name.length <= 63 ? name : `${name.slice(0, 54)}_${shortHash(name)}`;
}

export function planDDL(change: DictionaryChange): string[] {
  switch (change.kind) {
    case 'add_table': {
      if (change.superClass) return []; // child tables live in the root's physical table
      const t = quoteIdent(change.table);
      return [
        `CREATE TABLE ${t} (` +
          `"sys_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), ` +
          `"sys_class_name" text NOT NULL, ` +
          `"sys_created_on" timestamptz NOT NULL DEFAULT now(), ` +
          `"sys_created_by" text NOT NULL, ` +
          `"sys_updated_on" timestamptz NOT NULL DEFAULT now(), ` +
          `"sys_updated_by" text NOT NULL, ` +
          `"sys_mod_count" integer NOT NULL DEFAULT 0, ` +
          `"sys_scope" text NOT NULL DEFAULT 'global')`,
        `CREATE INDEX ${quoteIdent(indexName(change.table, ['sys_class_name'], 'idx'))} ON ${t} ("sys_class_name")`,
      ];
    }
    case 'add_field': {
      const t = quoteIdent(change.physical);
      const c = quoteIdent(change.column);
      const stmts = [`ALTER TABLE ${t} ADD COLUMN ${c} ${pgType(change.type)}`];
      if (change.type === 'reference') {
        stmts.push(`CREATE INDEX ${quoteIdent(indexName(change.physical, [change.column], 'idx'))} ON ${t} (${c})`);
      }
      return stmts;
    }
    case 'add_unique': {
      const t = quoteIdent(change.physical);
      return [
        `CREATE UNIQUE INDEX ${quoteIdent(indexName(change.physical, change.columns, 'uniq'))} ON ${t} ` +
          `(${change.columns.map(quoteIdent).join(', ')})`,
      ];
    }
    case 'add_index': {
      const t = quoteIdent(change.physical);
      return [`CREATE INDEX ${quoteIdent(indexName(change.physical, change.columns, 'idx'))} ON ${t} (${change.columns.map(quoteIdent).join(', ')})`];
    }
  }
}
