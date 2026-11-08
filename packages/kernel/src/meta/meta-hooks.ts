import { CREATABLE_FIELD_TYPES } from '@steward/shared';
import { rawInsert, systemValues } from '../db/raw';
import type { DataEngine } from '../data/data-engine';
import type { HookRegistry, SystemHook } from '../data/hooks';
import { ValidationError } from '../errors';
import { titleize } from '../util';
import { planDDL } from './schema-compiler';

const TABLE_NAME_RE = /^[a-z][a-z0-9_]{1,79}$/;
const ELEMENT_RE = /^[a-z][a-z0-9_]{0,79}$/;
const CREATABLE_TYPES: ReadonlySet<string> = new Set(CREATABLE_FIELD_TYPES);

function changed(ctx: { current: Record<string, unknown>; previous?: Readonly<Record<string, unknown>> }, key: string): boolean {
  return (ctx.previous?.[key] ?? null) !== (ctx.current[key] ?? null);
}

async function applyDDL(engine: DataEngine, statements: string[]): Promise<void> {
  for (const sql of statements) await engine.db.exec(sql);
}

async function ensureNumbering(engine: DataEngine, table: string, prefix: string, userName: string): Promise<void> {
  const existing = await engine.db.query(`SELECT 1 FROM "sys_number" WHERE "category" = $1`, [table]);
  if (existing.rows.length) {
    await engine.db.query(`UPDATE "sys_number" SET "prefix" = $1 WHERE "category" = $2`, [prefix, table]);
  } else {
    await rawInsert(engine.db, 'sys_number', {
      ...systemValues('sys_number', userName),
      category: table,
      prefix,
      number: 1000,
      maximum_digits: 7,
    });
  }
  if (!engine.meta.fields(table).has('number')) {
    await engine.insert(
      'sys_dictionary',
      { name: table, element: 'number', column_label: 'Number', internal_type: 'string', max_length: 40, read_only: true },
      { userName },
    );
  }
}

/**
 * Hooks that turn writes to sys_db_object / sys_dictionary / sys_choice into
 * schema changes. This is what makes the platform metadata-driven: inserting a
 * dictionary record *is* adding a column.
 */
export function metadataHooks(): SystemHook[] {
  return [
    // ---------------------------------------------------------- sys_db_object
    {
      name: 'sys_db_object: validate new table',
      table: 'sys_db_object',
      when: 'before',
      operations: ['insert'],
      async run({ engine, current }) {
        const name = String(current.name ?? '');
        if (!TABLE_NAME_RE.test(name)) {
          throw new ValidationError(`Invalid table name "${name}"`, 'Use lowercase snake_case, 2-80 characters');
        }
        if (engine.meta.hasTable(name)) throw new ValidationError(`Table ${name} already exists`);
        if (current.super_class) {
          const parent = engine.meta.getTableBySysId(String(current.super_class));
          if (!parent) throw new ValidationError(`Parent table ${String(current.super_class)} does not exist`);
          if (!parent.extendable) throw new ValidationError(`Table ${parent.name} is not extensible`);
          current.physical_name = parent.physical;
        } else {
          const exists = await engine.db.query<{ t: string | null }>(`SELECT to_regclass($1)::text AS t`, [`public.${name}`]);
          if (exists.rows[0]?.t) throw new ValidationError(`A database object named ${name} already exists`);
          current.physical_name = name;
        }
        current.label ??= titleize(name);
      },
    },
    {
      name: 'sys_db_object: create storage',
      table: 'sys_db_object',
      when: 'after',
      operations: ['insert'],
      async run({ engine, current, session }) {
        const name = String(current.name);
        await applyDDL(engine, planDDL({ kind: 'add_table', table: name, superClass: current.super_class as string | null }));
        await engine.meta.load(engine.db);
        if (current.number_prefix) await ensureNumbering(engine, name, String(current.number_prefix), session.userName);
      },
    },
    {
      name: 'sys_db_object: protect immutable attributes',
      table: 'sys_db_object',
      when: 'before',
      operations: ['update'],
      run(ctx) {
        for (const key of ['name', 'super_class', 'physical_name']) {
          if (changed(ctx, key)) throw new ValidationError(`sys_db_object.${key} cannot be changed once created`);
        }
      },
    },
    {
      name: 'sys_db_object: apply attribute changes',
      table: 'sys_db_object',
      when: 'after',
      operations: ['update'],
      async run(ctx) {
        await ctx.engine.meta.load(ctx.engine.db);
        if (changed(ctx, 'number_prefix') && ctx.current.number_prefix) {
          await ensureNumbering(ctx.engine, String(ctx.current.name), String(ctx.current.number_prefix), ctx.session.userName);
        }
      },
    },
    {
      name: 'sys_db_object: block delete',
      table: 'sys_db_object',
      when: 'before',
      operations: ['delete'],
      run() {
        throw new ValidationError('Deleting tables is not supported yet');
      },
    },

    // --------------------------------------------------------- sys_dictionary
    {
      name: 'sys_dictionary: validate new field',
      table: 'sys_dictionary',
      when: 'before',
      operations: ['insert'],
      run({ engine, current }) {
        const { meta } = engine;
        const table = String(current.name ?? '');
        const element = String(current.element ?? '');
        if (!meta.hasTable(table)) throw new ValidationError(`Table ${table} does not exist`);
        if (!ELEMENT_RE.test(element)) throw new ValidationError(`Invalid column name "${element}"`);
        if (element.startsWith('sys_')) throw new ValidationError(`Column names starting with sys_ are reserved`);

        const existing = meta.fields(table).get(element);
        if (existing) throw new ValidationError(`Field ${element} is already defined on ${existing.table}`);
        for (const child of meta.descendants(table).slice(1)) {
          if (meta.getTable(child).ownFields.has(element)) {
            throw new ValidationError(`Field ${element} is already defined on child table ${child}`);
          }
        }

        const type = String(current.internal_type ?? '');
        if (!CREATABLE_TYPES.has(type)) throw new ValidationError(`Invalid field type "${type}"`);
        if (type === 'reference') {
          if (!current.reference || !meta.hasTable(String(current.reference))) {
            throw new ValidationError(`Reference field ${table}.${element} needs an existing reference table`);
          }
        } else {
          current.reference = null;
        }
        if (type === 'string') current.max_length ??= 40;

        // Storage column: reuse the element name unless a sibling already uses it.
        const t = meta.getTable(table);
        const used = meta.hierarchyColumns(t.root);
        const column = used.has(element) ? `${table}_${element}` : element;
        if (used.has(column)) throw new ValidationError(`Cannot allocate a storage column for ${table}.${element}`);
        current.column_name = column;
        current.column_label ??= titleize(element);
      },
    },
    {
      name: 'sys_dictionary: add column',
      table: 'sys_dictionary',
      when: 'after',
      operations: ['insert'],
      async run({ engine, current }) {
        const t = engine.meta.getTable(String(current.name));
        await applyDDL(
          engine,
          planDDL({ kind: 'add_field', physical: t.physical, column: String(current.column_name), type: current.internal_type as never }),
        );
        await engine.meta.load(engine.db);
      },
    },
    {
      name: 'sys_dictionary: protect immutable attributes',
      table: 'sys_dictionary',
      when: 'before',
      operations: ['update'],
      run(ctx) {
        for (const key of ['name', 'element', 'internal_type', 'reference', 'column_name']) {
          if (changed(ctx, key)) throw new ValidationError(`sys_dictionary.${key} cannot be changed once created`);
        }
      },
    },
    {
      name: 'sys_dictionary: refresh metadata',
      table: 'sys_dictionary',
      when: 'after',
      operations: ['update'],
      async run({ engine }) {
        await engine.meta.load(engine.db);
      },
    },
    {
      name: 'sys_dictionary: block delete',
      table: 'sys_dictionary',
      when: 'before',
      operations: ['delete'],
      run() {
        throw new ValidationError('Deleting fields is not supported yet; set active=false instead');
      },
    },

    // ------------------------------------------------------------- sys_choice
    {
      name: 'sys_choice: refresh metadata',
      table: 'sys_choice',
      when: 'after',
      operations: ['insert', 'update', 'delete'],
      async run({ engine }) {
        await engine.meta.load(engine.db);
      },
    },

    // --------------------------------------------------------------- sys_user
    {
      name: 'sys_user: compose name',
      table: 'sys_user',
      when: 'before',
      operations: ['insert', 'update'],
      run(ctx) {
        const { current } = ctx;
        if (changed(ctx, 'first_name') || changed(ctx, 'last_name') || current.name == null) {
          const composed = [current.first_name, current.last_name].filter((p) => p != null && p !== '').join(' ');
          if (composed) current.name = composed;
        }
      },
    },
  ];
}

export function registerMetadataHooks(registry: HookRegistry): void {
  registry.register(...metadataHooks());
}
