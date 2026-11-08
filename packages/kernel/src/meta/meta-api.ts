import { describeIssues, fieldSpecSchema, tableSpecSchema, type FieldSpec, type FieldType, type TableSpec } from '@steward/shared';
import type { z } from 'zod';
import { coerceValue } from '../data/coerce';
import type { DataEngine } from '../data/data-engine';
import { ForbiddenError, ValidationError } from '../errors';
import { SYSTEM_SESSION, type Session } from '../session';
import type { MetaService } from './meta-service';

export interface FieldDescription {
  element: string;
  label: string;
  type: FieldType;
  reference: string | null;
  maxLength: number | null;
  mandatory: boolean;
  defaultValue: string | null;
  display: boolean;
  readOnly: boolean;
  system: boolean;
  definedOn: string;
  column: string;
  choices: Array<{ value: string; label: string }>;
}

export interface TableDescription {
  name: string;
  label: string;
  extends: string | null;
  root: string;
  physical: string;
  extendable: boolean;
  numberPrefix: string | null;
  audit: boolean;
  children: string[];
  fields: FieldDescription[];
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const res = schema.safeParse(input);
  if (!res.success) throw new ValidationError('Invalid metadata definition', describeIssues(res.error));
  return res.data;
}

export function describeTable(meta: MetaService, name: string): TableDescription {
  const t = meta.getTable(name);
  return {
    name: t.name,
    label: t.label,
    extends: t.superClass,
    root: t.root,
    physical: t.physical,
    extendable: t.extendable,
    numberPrefix: t.numberPrefix,
    audit: t.audit,
    children: [...t.children],
    fields: [...meta.fields(name).values()].map((f) => ({
      element: f.element,
      label: f.label,
      type: f.type,
      reference: f.reference,
      maxLength: f.maxLength,
      mandatory: f.mandatory,
      defaultValue: f.defaultValue,
      display: f.display,
      readOnly: f.readOnly,
      system: f.system,
      definedOn: f.table,
      column: f.column,
      choices: f.choices.map((c) => ({ value: c.value, label: c.label })),
    })),
  };
}

/**
 * Convenience API over the metadata tables. Everything here is expressed as
 * ordinary record writes to sys_db_object / sys_dictionary / sys_choice; the
 * metadata hooks perform the actual DDL. Each call is a single transaction.
 */
export class MetaApi {
  constructor(private readonly engine: DataEngine) {}

  createTable(input: TableSpec | unknown, session: Session): Promise<TableDescription> {
    const spec = parse(tableSpecSchema, input);
    return this.engine.transaction(async (e) => {
      let superSysId: string | null = null;
      if (spec.extends) {
        if (!e.meta.hasTable(spec.extends)) throw new ValidationError(`Cannot extend unknown table ${spec.extends}`);
        superSysId = e.meta.getTable(spec.extends).sysId;
      }
      await e.insert(
        'sys_db_object',
        {
          name: spec.name,
          label: spec.label,
          super_class: superSysId,
          is_extendable: spec.extendable,
          number_prefix: spec.numberPrefix,
          audit: spec.audit,
        },
        session,
      );
      for (const field of spec.fields ?? []) await this.insertField(e, spec.name, field, session);
      return describeTable(e.meta, spec.name);
    });
  }

  addField(table: string, input: FieldSpec | unknown, session: Session): Promise<FieldDescription> {
    const spec = parse(fieldSpecSchema, input);
    return this.engine.transaction(async (e) => {
      if (!e.meta.hasTable(table)) throw new ValidationError(`Table ${table} does not exist`);
      await this.insertField(e, table, spec, session);
      return describeTable(e.meta, table).fields.find((f) => f.element === spec.element)!;
    });
  }

  /** Resolved schema of a table. With a user session: 403 if the table is unreadable, unreadable fields omitted. */
  describe(table: string, session: Session = SYSTEM_SESSION): TableDescription {
    const d = describeTable(this.engine.meta, table);
    if (session.system) return d;
    const { acl } = this.engine;
    if (acl.tableDecision(session, table, 'read') === false) throw new ForbiddenError(`Not authorized to read ${table}`);
    return { ...d, fields: d.fields.filter((f) => acl.fieldDecision(session, table, f.element, 'read') !== false) };
  }

  /** All tables (with a user session: only those the user may read at least partially). */
  list(session: Session = SYSTEM_SESSION): Array<Pick<TableDescription, 'name' | 'label' | 'extends'>> {
    return this.engine.meta
      .listTables()
      .filter((t) => session.system || this.engine.acl.tableDecision(session, t.name, 'read') !== false)
      .map((t) => ({ name: t.name, label: t.label, extends: t.superClass }));
  }

  private async insertField(e: DataEngine, table: string, spec: FieldSpec, session: Session): Promise<void> {
    if (spec.choices?.length && spec.type !== 'choice') {
      throw new ValidationError(`Choices are only allowed on choice fields (${table}.${spec.element})`);
    }
    await e.insert(
      'sys_dictionary',
      {
        name: table,
        element: spec.element,
        column_label: spec.label,
        internal_type: spec.type,
        reference: spec.reference,
        max_length: spec.maxLength,
        mandatory: spec.mandatory,
        default_value: spec.defaultValue === undefined ? undefined : String(spec.defaultValue),
        display: spec.display,
      },
      session,
    );
    for (const [i, c] of (spec.choices ?? []).entries()) {
      await e.insert(
        'sys_choice',
        { name: table, element: spec.element, value: c.value, label: c.label, sequence: c.sequence ?? (i + 1) * 100 },
        session,
      );
    }
    if (spec.defaultValue !== undefined) {
      coerceValue(e.meta.field(table, spec.element), String(spec.defaultValue)); // validates the default
    }
  }
}
