import type { FieldType } from '@steward/shared';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db';
import { rawInsert, systemValues } from '../db/raw';
import { planDDL } from '../meta/schema-compiler';
import { titleize } from '../util';

/**
 * Version of the system schema + seed data. Bootstrapping is incremental:
 * an instance created by an older version gets the missing system tables and
 * fields added, and the seed steps newer than its recorded version applied.
 *
 *   1  Phase 1: dictionary, numbering, audit, properties, sys_user
 *   2  Phase 2: identity (roles, groups, memberships), ACLs, sessions
 *   3  Phase 3: UI layouts (sys_ui_list, sys_ui_form, sys_ui_section), journal entries
 *   4  Phase 4: server scripting (sys_script business rules, sys_script_include, ACL scripts)
 */
export const BOOTSTRAP_VERSION = 4;
const VERSION_PROPERTY = 'glide.steward.bootstrap_version';

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
  choices?: Array<{ value: string; label: string }>;
}

interface BootstrapTable {
  name: string;
  label: string;
  extendable?: boolean;
  audit?: boolean;
  fields: BootstrapField[];
  unique?: string[][];
  /** Plain indexes (reference columns are indexed automatically). */
  indexes?: string[][];
}

const ref = (element: string, reference: string, extra: Partial<BootstrapField> = {}): BootstrapField => ({
  element,
  type: 'reference',
  reference,
  mandatory: true,
  ...extra,
});

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
      { element: 'user_password', type: 'password', label: 'Password' },
      { element: 'locked_out', type: 'boolean', defaultValue: 'false' },
    ],
    unique: [['user_name']],
  },
  // ------------------------------------------------------------ identity (v2)
  {
    name: 'sys_user_role',
    label: 'Role',
    fields: [
      { element: 'name', type: 'string', maxLength: 100, mandatory: true, display: true },
      { element: 'description', type: 'text' },
      { element: 'elevated_privilege', type: 'boolean', defaultValue: 'false' },
    ],
    unique: [['name']],
  },
  {
    name: 'sys_user_role_contains',
    label: 'Contained Role',
    fields: [ref('role', 'sys_user_role'), ref('contains', 'sys_user_role')],
    unique: [['role', 'contains']],
  },
  {
    name: 'sys_user_group',
    label: 'Group',
    fields: [
      { element: 'name', type: 'string', maxLength: 80, mandatory: true, display: true },
      { element: 'description', type: 'text' },
      { element: 'manager', type: 'reference', reference: 'sys_user' },
      { element: 'email', type: 'string', maxLength: 100 },
      { element: 'active', type: 'boolean', defaultValue: 'true' },
    ],
  },
  {
    name: 'sys_user_grmember',
    label: 'Group Member',
    fields: [ref('user', 'sys_user'), ref('group', 'sys_user_group')],
    unique: [['user', 'group']],
  },
  {
    name: 'sys_user_has_role',
    label: 'User Role',
    fields: [ref('user', 'sys_user'), ref('role', 'sys_user_role')],
    unique: [['user', 'role']],
  },
  {
    name: 'sys_group_has_role',
    label: 'Group Role',
    fields: [ref('group', 'sys_user_group'), ref('role', 'sys_user_role')],
    unique: [['group', 'role']],
  },
  {
    name: 'sys_security_acl',
    label: 'Access Control',
    fields: [
      { element: 'name', type: 'string', maxLength: 160, mandatory: true, display: true },
      {
        element: 'operation',
        type: 'choice',
        mandatory: true,
        choices: [
          { value: 'read', label: 'read' },
          { value: 'write', label: 'write' },
          { value: 'create', label: 'create' },
          { value: 'delete', label: 'delete' },
        ],
      },
      { element: 'active', type: 'boolean', defaultValue: 'true' },
      { element: 'admin_overrides', type: 'boolean', defaultValue: 'true' },
      { element: 'condition', type: 'text' },
      { element: 'script', type: 'script', label: 'Script' },
      { element: 'description', type: 'text' },
    ],
  },
  {
    name: 'sys_security_acl_role',
    label: 'Access Role',
    fields: [ref('sys_security_acl', 'sys_security_acl', { label: 'Access control' }), ref('sys_user_role', 'sys_user_role', { label: 'Role' })],
    unique: [['sys_security_acl', 'sys_user_role']],
  },
  {
    name: 'sys_user_session',
    label: 'User Session',
    audit: false,
    fields: [
      ref('user', 'sys_user'),
      { element: 'token_hash', type: 'string', maxLength: 64, mandatory: true, readOnly: true },
      { element: 'expires', type: 'datetime', mandatory: true },
      { element: 'impersonating', type: 'reference', reference: 'sys_user' },
    ],
    unique: [['token_hash']],
  },
  // ------------------------------------------------------------- UI + journal (v3)
  {
    name: 'sys_ui_list',
    label: 'List Layout',
    fields: [
      { element: 'name', type: 'string', maxLength: 80, mandatory: true, display: true, label: 'Table' },
      { element: 'view', type: 'string', maxLength: 40, mandatory: true, defaultValue: 'default' },
      { element: 'elements', type: 'text', mandatory: true, label: 'Columns' },
    ],
    unique: [['name', 'view']],
  },
  {
    name: 'sys_ui_form',
    label: 'Form Layout',
    fields: [
      { element: 'name', type: 'string', maxLength: 80, mandatory: true, display: true, label: 'Table' },
      { element: 'view', type: 'string', maxLength: 40, mandatory: true, defaultValue: 'default' },
      { element: 'related_lists', type: 'text', label: 'Related lists' },
    ],
    unique: [['name', 'view']],
  },
  {
    name: 'sys_ui_section',
    label: 'Form Section',
    fields: [
      ref('form', 'sys_ui_form'),
      { element: 'caption', type: 'string', maxLength: 80, display: true },
      { element: 'position', type: 'integer', defaultValue: '0' },
      { element: 'elements', type: 'text', label: 'Fields' },
    ],
  },
  {
    name: 'sys_journal_field',
    label: 'Journal Entry',
    audit: false,
    fields: [
      { element: 'name', type: 'string', maxLength: 80, mandatory: true, label: 'Table' },
      { element: 'element', type: 'string', maxLength: 80, mandatory: true, label: 'Field' },
      { element: 'element_id', type: 'guid', mandatory: true, label: 'Record' },
      { element: 'value', type: 'text', display: true },
    ],
    indexes: [['element_id']],
  },
  // ----------------------------------------------------------- scripting (v4)
  {
    name: 'sys_script',
    label: 'Business Rule',
    fields: [
      { element: 'name', type: 'string', maxLength: 100, mandatory: true, display: true },
      { element: 'collection', type: 'string', maxLength: 80, mandatory: true, label: 'Table' },
      {
        element: 'when',
        type: 'choice',
        mandatory: true,
        defaultValue: 'before',
        choices: [
          { value: 'before', label: 'before' },
          { value: 'after', label: 'after' },
          { value: 'async', label: 'async' },
        ],
      },
      { element: 'order', type: 'integer', defaultValue: '100' },
      { element: 'action_insert', type: 'boolean', defaultValue: 'false', label: 'Insert' },
      { element: 'action_update', type: 'boolean', defaultValue: 'false', label: 'Update' },
      { element: 'action_delete', type: 'boolean', defaultValue: 'false', label: 'Delete' },
      { element: 'filter_condition', type: 'text', label: 'Filter condition' },
      { element: 'condition', type: 'string', maxLength: 255, label: 'Condition' },
      { element: 'script', type: 'script', mandatory: true },
      { element: 'active', type: 'boolean', defaultValue: 'true' },
      { element: 'description', type: 'text' },
    ],
    indexes: [['collection']],
  },
  {
    name: 'sys_script_include',
    label: 'Script Include',
    fields: [
      { element: 'name', type: 'string', maxLength: 80, mandatory: true, display: true },
      { element: 'api_name', type: 'string', maxLength: 160, readOnly: true, label: 'API name' },
      { element: 'script', type: 'script', mandatory: true },
      { element: 'active', type: 'boolean', defaultValue: 'true' },
      { element: 'client_callable', type: 'boolean', defaultValue: 'false', label: 'Client callable' },
      { element: 'description', type: 'text' },
    ],
    unique: [['name']],
  },
];

export async function isBootstrapped(db: Db): Promise<boolean> {
  const res = await db.query<{ t: string | null }>(`SELECT to_regclass('public.sys_db_object')::text AS t`);
  return res.rows[0]?.t != null;
}

async function tableExists(db: Db, physical: string): Promise<boolean> {
  const res = await db.query<{ t: string | null }>(`SELECT to_regclass($1)::text AS t`, [`public.${physical}`]);
  return res.rows[0]?.t != null;
}

async function columnExists(db: Db, physical: string, column: string): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [physical, column],
  );
  return res.rows.length > 0;
}

export async function bootstrapVersion(db: Db): Promise<number> {
  if (!(await isBootstrapped(db))) return 0;
  const res = await db.query<{ value: string | null }>(`SELECT "value" FROM "sys_properties" WHERE "name" = $1`, [VERSION_PROPERTY]);
  return Number(res.rows[0]?.value ?? 1) || 1;
}

/**
 * Create (or upgrade to) the current system schema. Idempotent: creates missing
 * system tables, fields and choices, then runs seed steps newer than the
 * instance's recorded version. Runs in one transaction.
 */
export async function bootstrap(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await bootstrapVersion(tx);
    if (current >= BOOTSTRAP_VERSION) return;
    await ensureSchema(tx);
    for (const step of SEED_STEPS) if (step.version > current) await step.run(tx);
    await tx.query(`UPDATE "sys_properties" SET "value" = $1, "sys_updated_on" = now() WHERE "name" = $2`, [
      String(BOOTSTRAP_VERSION),
      VERSION_PROPERTY,
    ]);
  });
}

async function ensureSchema(tx: Db): Promise<void> {
  // 1. Physical storage.
  for (const t of SYSTEM_TABLES) {
    const created = !(await tableExists(tx, t.name));
    if (created) for (const sql of planDDL({ kind: 'add_table', table: t.name })) await tx.exec(sql);
    for (const f of t.fields) {
      if (!created && (await columnExists(tx, t.name, f.element))) continue;
      for (const sql of planDDL({ kind: 'add_field', physical: t.name, column: f.element, type: f.type })) await tx.exec(sql);
    }
    if (created) {
      for (const cols of t.unique ?? []) {
        for (const sql of planDDL({ kind: 'add_unique', physical: t.name, columns: cols })) await tx.exec(sql);
      }
      for (const cols of t.indexes ?? []) {
        for (const sql of planDDL({ kind: 'add_index', physical: t.name, columns: cols })) await tx.exec(sql);
      }
    }
  }

  // 2. Describe it in the dictionary (only what is missing).
  const tables = new Set((await tx.query<{ name: string }>(`SELECT "name" FROM "sys_db_object"`)).rows.map((r) => r.name));
  const dict = new Set(
    (await tx.query<{ name: string; element: string }>(`SELECT "name", "element" FROM "sys_dictionary"`)).rows.map((r) => `${r.name}.${r.element}`),
  );
  const choices = new Set(
    (await tx.query<{ name: string; element: string; value: string }>(`SELECT "name", "element", "value" FROM "sys_choice"`)).rows.map(
      (r) => `${r.name}.${r.element}=${r.value}`,
    ),
  );
  for (const t of SYSTEM_TABLES) {
    if (!tables.has(t.name)) {
      await rawInsert(tx, 'sys_db_object', {
        ...systemValues('sys_db_object', 'system', randomUUID()),
        name: t.name,
        label: t.label,
        super_class: null,
        physical_name: t.name,
        is_extendable: t.extendable ?? false,
        number_prefix: null,
        audit: t.audit ?? true,
      });
    }
    for (const f of t.fields) {
      if (!dict.has(`${t.name}.${f.element}`)) {
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
      for (const [i, c] of (f.choices ?? []).entries()) {
        if (choices.has(`${t.name}.${f.element}=${c.value}`)) continue;
        await rawInsert(tx, 'sys_choice', {
          ...systemValues('sys_choice', 'system'),
          name: t.name,
          element: f.element,
          value: c.value,
          label: c.label,
          sequence: (i + 1) * 100,
          inactive: false,
        });
      }
    }
  }
}

// ------------------------------------------------------------------ seeds

async function findId(tx: Db, physical: string, column: string, value: string): Promise<string | null> {
  const res = await tx.query<{ sys_id: string }>(`SELECT "sys_id" FROM "${physical}" WHERE "${column}" = $1 LIMIT 1`, [value]);
  return res.rows[0]?.sys_id ?? null;
}

async function insertRow(tx: Db, table: string, values: Record<string, unknown>): Promise<string> {
  const sysId = randomUUID();
  await rawInsert(tx, table, { ...systemValues(table, 'system', sysId), ...values });
  return sysId;
}

/** Seed ACL definitions: [name, operation, roles, adminOverrides, description]. */
const SEED_ACLS: Array<[string, string, string[], boolean, string]> = [
  ...['read', 'write', 'create', 'delete'].flatMap((op): Array<[string, string, string[], boolean, string]> => [
    ['sys_security_acl', op, ['security_admin'], false, 'Only security admins manage ACLs'],
    ['sys_security_acl_role', op, ['security_admin'], false, 'Only security admins manage ACL roles'],
  ]),
  ['sys_user', 'read', [], true, 'Any authenticated user can look up users'],
  ['sys_user_group', 'read', [], true, 'Any authenticated user can look up groups'],
  ['sys_user_role', 'read', [], true, 'Any authenticated user can look up roles'],
];

const SEED_STEPS: Array<{ version: number; run(tx: Db): Promise<void> }> = [
  {
    version: 1,
    async run(tx) {
      await rawInsert(tx, 'sys_properties', {
        ...systemValues('sys_properties', 'system'),
        name: VERSION_PROPERTY,
        value: '1',
        description: 'Version of the system table bootstrap applied to this instance.',
      });
      await insertRow(tx, 'sys_user', {
        user_name: 'admin',
        first_name: 'System',
        last_name: 'Administrator',
        name: 'System Administrator',
        active: true,
        locked_out: false,
      });
    },
  },
  {
    version: 2,
    async run(tx) {
      await tx.query(`UPDATE "sys_user" SET "locked_out" = false WHERE "locked_out" IS NULL`);
      const roles: Record<string, string> = {};
      for (const [name, description, elevated] of [
        ['admin', 'Full access to the instance, except elevated privileges', false],
        ['security_admin', 'Manage access controls (elevated)', true],
        ['impersonator', 'May impersonate non-admin users', false],
      ] as const) {
        roles[name] = (await findId(tx, 'sys_user_role', 'name', name)) ?? (await insertRow(tx, 'sys_user_role', { name, description, elevated_privilege: elevated }));
      }
      const adminUser = await findId(tx, 'sys_user', 'user_name', 'admin');
      if (adminUser) {
        for (const role of ['admin', 'security_admin']) {
          const exists = await tx.query(`SELECT 1 FROM "sys_user_has_role" WHERE "user" = $1 AND "role" = $2`, [adminUser, roles[role]]);
          if (!exists.rows.length) await insertRow(tx, 'sys_user_has_role', { user: adminUser, role: roles[role] });
        }
      }
      for (const [name, operation, aclRoles, adminOverrides, description] of SEED_ACLS) {
        const acl = await insertRow(tx, 'sys_security_acl', { name, operation, active: true, admin_overrides: adminOverrides, condition: null, description });
        for (const role of aclRoles) await insertRow(tx, 'sys_security_acl_role', { sys_security_acl: acl, sys_user_role: roles[role] });
      }
    },
  },
  {
    version: 3,
    async run(tx) {
      for (const [name, elements] of SEED_LIST_LAYOUTS) {
        const exists = await tx.query(`SELECT 1 FROM "sys_ui_list" WHERE "name" = $1 AND "view" = 'default'`, [name]);
        if (!exists.rows.length) await insertRow(tx, 'sys_ui_list', { name, view: 'default', elements });
      }
    },
  },
  {
    version: 4,
    async run(tx) {
      for (const [name, elements] of SEED_LIST_LAYOUTS) {
        const exists = await tx.query(`SELECT 1 FROM "sys_ui_list" WHERE "name" = $1 AND "view" = 'default'`, [name]);
        if (!exists.rows.length) await insertRow(tx, 'sys_ui_list', { name, view: 'default', elements });
      }
    },
  },
];

/** Default list columns for system tables: [table, comma-separated field paths]. */
const SEED_LIST_LAYOUTS: Array<[string, string]> = [
  ['sys_db_object', 'name,label,super_class,number_prefix,is_extendable,sys_updated_on'],
  ['sys_dictionary', 'name,element,column_label,internal_type,reference,mandatory,active'],
  ['sys_choice', 'name,element,value,label,sequence,inactive'],
  ['sys_user', 'user_name,name,email,active,locked_out'],
  ['sys_user_role', 'name,description,elevated_privilege'],
  ['sys_user_group', 'name,manager,email,active'],
  ['sys_user_grmember', 'user,group'],
  ['sys_user_has_role', 'user,role'],
  ['sys_group_has_role', 'group,role'],
  ['sys_security_acl', 'name,operation,condition,admin_overrides,active'],
  ['sys_audit', 'tablename,documentkey,fieldname,oldvalue,newvalue,user,sys_created_on'],
  ['sys_ui_list', 'name,view,elements'],
  ['sys_ui_form', 'name,view,related_lists'],
  ['sys_ui_section', 'form,caption,position,elements'],
  ['sys_journal_field', 'name,element,element_id,value,sys_created_by,sys_created_on'],
  ['sys_script', 'name,collection,when,order,action_insert,action_update,action_delete,active'],
  ['sys_script_include', 'name,api_name,client_callable,active,description,sys_updated_on'],
];
