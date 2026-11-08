import type { FieldType } from '@steward/shared';

export interface ChoiceMeta {
  value: string;
  label: string;
  sequence: number;
}

export interface FieldMeta {
  /** sys_dictionary sys_id; null for synthesized system fields. */
  sysId: string | null;
  /** Table that defines the field (may be an ancestor of the table being queried). */
  table: string;
  element: string;
  label: string;
  type: FieldType;
  reference: string | null;
  maxLength: number | null;
  mandatory: boolean;
  defaultValue: string | null;
  /** Physical column inside the hierarchy's root table. */
  column: string;
  active: boolean;
  display: boolean;
  readOnly: boolean;
  system: boolean;
  choices: ChoiceMeta[];
}

export interface TableMeta {
  sysId: string;
  name: string;
  label: string;
  superClass: string | null;
  /** Root table of the hierarchy (itself when not extending anything). */
  root: string;
  /** Physical Postgres table (== root). */
  physical: string;
  extendable: boolean;
  numberPrefix: string | null;
  audit: boolean;
  /** Fields defined directly on this table, including inactive ones. */
  ownFields: Map<string, FieldMeta>;
  children: string[];
}

/** Columns present on every physical table. Synthesized into every table's field list. */
export const SYSTEM_FIELDS: ReadonlyArray<{ element: string; type: FieldType; label: string }> = [
  { element: 'sys_id', type: 'guid', label: 'Sys ID' },
  { element: 'sys_class_name', type: 'sys_class_name', label: 'Class' },
  { element: 'sys_created_on', type: 'datetime', label: 'Created' },
  { element: 'sys_created_by', type: 'string', label: 'Created by' },
  { element: 'sys_updated_on', type: 'datetime', label: 'Updated' },
  { element: 'sys_updated_by', type: 'string', label: 'Updated by' },
  { element: 'sys_mod_count', type: 'integer', label: 'Updates' },
  { element: 'sys_scope', type: 'string', label: 'Application' },
];

export const SYSTEM_FIELD_NAMES: ReadonlySet<string> = new Set(SYSTEM_FIELDS.map((f) => f.element));
