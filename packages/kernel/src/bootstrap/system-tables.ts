import type { FieldType } from '@steward/shared';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db';
import { rawInsert, systemValues } from '../db/raw';
import { planDDL } from '../meta/schema-compiler';
import { titleize } from '../util';

export const BOOTSTRAP_VERSION = 1;

interface BootstrapField {
  element: string;
  type: FieldType;
  label?: string;
  reference?: string;
  maxLength?: number;
  mandatory?: boolean;
  defaultValue?: string;
  display?: boolean;
  readOnly?: boolean;
}

interface BootstrapTable {
  name: string;
  label: string;
  extendable?: boolean;
  audit?: boolean;
  fields: BootstrapField[];
  unique?: string[][];
}

/**
 * The self-describing system tables. They are created with hand-written DDL
 * and then described in sys_db_object / sys_dictionary, so from then on the
 * platform manages them through the same Record API as any other table.
 */
export const SYSTEM_TABLES: BootstrapTable[] = [
  {
    name: 'sys_db_object',
    label: 'Table',
    fields: [
      { element: 'name', type: 'string', maxLength: 80, mandatory: true, display: true },
      { element: 'label', type: 'string', maxLength: 80 },
      { element: 'super_class', type: 'reference', reference: 'sys_db_object', label: 'Extends table' },
      { element: 'physical_name', type: 'string', maxLength: 80, readOnly: true },
      { element: 'is_extendable', type: 'boolean', defaultValue: 'true', label: 'Extensible' },
      { element: 'number_prefix', type: 'string', maxLength: 10 },
      { element: 'audit', type: 'boolean', defaultValue: 'true' },
    ],
    unique: [['name']],
  },
  {
    name: 'sys_dictionary',
    label: 'Dictionary Entry',
    fields: [
      { element: 'name', type: 'string', maxLength: 80, mandatory: true, label: 'Table' },
      { element: 'element', type: 'string', maxLength: 80, mandatory: true, label: 'Column name' },
      { element: 'column_label', type: 'string', maxLength: 80, display: true },
      { element: 'internal_type', type: 'string', maxLength: 40, mandatory: true, label: 'Type' },
      { element: 'reference', type: 'string', maxLength: 80 },
      { element: 'max_length', type: 'integer' },
      { element: 'mandatory', type: 'boolean', defaultValue: 'false' },
      { element: 'default_value', type: 'string', maxLength: 255 },
      { element: 'column_name', type: 'string', maxLength: 80, readOnly: true, label: 'Storage column' },
      { element: 'active', type: 'boolean', defaultValue: 'true' },
      { element: 'display', type: 'boolean', defaultValue: 'false' },
      { element: 'read_only', type: 'boolean', defaultValue: 'false' },
    ],
    unique: [['name', 'element']],
  },
  {
    name: 'sys_choice',
    label: 'Choice',
    fields: [
      { element: 'name', type: 'string', maxLength: 80, mandatory: true, label: 'Table' },
      { element: 'element', type: 'string', maxLength: 80, mandatory: true },
      { element: 'value', type: 'string', maxLength: 255, mandatory: true },
      { element: 'label', type: 'string', maxLength: 255, mandatory: true, display: true },
      { element: 'sequence', type: 'integer' },
      { element: 'inactive', type: 'boolean', defaultValue: 'false' },
    ],
    unique: [['name', 'element', 'value']],
  },
  {
    name: 'sys_number',
    label: 'Number',
    audit: false,
    fields: [
      { element: 'category', type: 'string', maxLength: 80, mandatory: true, display: true, label: 'Table' },
      { element: 'prefix', type: 'string', maxLength: 10, mandatory: true },
      { element: 'number', type: 'integer', mandatory: true },
      { element: 'maximum_digits', type: 'integer', defaultValue: '7' },
    ],
    unique: [['category']],
  },
  {
    name: 'sys_audit',
    label: 'Audit',
    audit: false,
    fields: [
      { element: 'tablename', type: 'string', maxLength: 80 },
      { element: 'documentkey', type: 'guid' },
      { element: 'fieldname', type: 'string', maxLength: 80 },
      { element: 'oldvalue', type: 'text' },
      { element: 'newvalue', type: 'text' },
      { element: 'user', type: 'string', maxLength: 80 },
      { element: 'record_checkpoint', type: 'integer' },
      { element: 'reason', type: 'string', maxLength: 255 },
    ],
  },
  {
    name: 'sys_properties',
    label: 'System Property',
    fields: [
      { element: 'name', type: 'string', maxLength: 255, mandatory: true, display: true },
      { element: 'value', type: 'text' },
      { element: 'description', type: 'text' },
    ],
    unique: [['name']],
  },
  {
    name: 'sys_user',
    label: 'User',
    extendable: true,
    fields: [
      { element: 'user_name', type: 'string', maxLength: 80, mandatory: true },
      { element: 'first_name', type: 'string', maxLength: 50 },
      { element: 'last_name', type: 'string', maxLength: 50 },
      { element: 'name', type: 'string', maxLength: 151, display: true },
      { element: 'email', type: 'string', maxLength: 100 },
      { element: 'active', type: 'boolean', defaultValue: 'true' },
    ],
    unique: [['user_name']],
  },
];

export async function isBootstrapped(db: Db): Promise<boolean> {
  const res = await db.query<{ t: string | null }>(`SELECT to_regclass('public.sys_db_object')::text AS t`);
  return res.rows[0]?.t != null;
}

export async function bootstrap(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    for (const t of SYSTEM_TABLES) {
      for (const sql of planDDL({ kind: 'add_table', table: t.name })) await tx.exec(sql);
      for (const f of t.fields) {
        for (const sql of planDDL({ kind: 'add_field', physical: t.name, column: f.element, type: f.type })) {
          await tx.exec(sql);
        }
      }
      for (const cols of t.unique ?? []) {
        for (const sql of planDDL({ kind: 'add_unique', physical: t.name, columns: cols })) await tx.exec(sql);
      }
    }

    const tableIds = new Map(SYSTEM_TABLES.map((t) => [t.name, randomUUID()]));
    for (const t of SYSTEM_TABLES) {
      await rawInsert(tx, 'sys_db_object', {
        ...systemValues('sys_db_object', 'system', tableIds.get(t.name)),
        name: t.name,
        label: t.label,
        super_class: null,
        physical_name: t.name,
        is_extendable: t.extendable ?? false,
        number_prefix: null,
        audit: t.audit ?? true,
      });
      for (const f of t.fields) {
        await rawInsert(tx, 'sys_dictionary', {
          ...systemValues('sys_dictionary', 'system'),
          name: t.name,
          element: f.element,
          column_label: f.label ?? titleize(f.element),
          internal_type: f.type,
          reference: f.reference ?? null,
          max_length: f.maxLength ?? null,
          mandatory: f.mandatory ?? false,
          default_value: f.defaultValue ?? null,
          column_name: f.element,
          active: true,
          display: f.display ?? false,
          read_only: f.readOnly ?? false,
        });
      }
    }

    await rawInsert(tx, 'sys_properties', {
      ...systemValues('sys_properties', 'system'),
      name: 'glide.steward.bootstrap_version',
      value: String(BOOTSTRAP_VERSION),
      description: 'Version of the system table bootstrap applied to this instance.',
    });
    await rawInsert(tx, 'sys_user', {
      ...systemValues('sys_user', 'system'),
      user_name: 'admin',
      first_name: 'System',
      last_name: 'Administrator',
      name: 'System Administrator',
      active: true,
    });
  });
}
