import type { FieldType } from '@steward/shared';
import type { Db } from '../db/db';
import { NotFoundError, ValidationError } from '../errors';
import { SYSTEM_FIELDS, type ChoiceMeta, type FieldMeta, type TableMeta } from './types';

interface TableRow {
  sys_id: string;
  name: string;
  label: string | null;
  super_class: string | null;
  physical_name: string | null;
  is_extendable: boolean | null;
  number_prefix: string | null;
  audit: boolean | null;
}

interface DictRow {
  sys_id: string;
  name: string;
  element: string;
  column_label: string | null;
  internal_type: string;
  reference: string | null;
  max_length: number | null;
  mandatory: boolean | null;
  default_value: string | null;
  column_name: string | null;
  active: boolean | null;
  display: boolean | null;
  read_only: boolean | null;
}

interface ChoiceRow {
  name: string;
  element: string;
  value: string;
  label: string;
  sequence: number | null;
}

/**
 * In-memory cache of the dictionary (sys_db_object, sys_dictionary, sys_choice).
 * Reloaded after every metadata change. `version` increments on each reload so
 * callers can detect that the cache changed during a failed transaction.
 */
export class MetaService {
  private tables = new Map<string, TableMeta>();
  private bySysId = new Map<string, TableMeta>();
  private fieldCache = new Map<string, Map<string, FieldMeta>>();
  version = 0;

  async load(db: Db): Promise<void> {
    const [tablesRes, dictRes, choiceRes] = [
      await db.query<TableRow>(
        `SELECT sys_id, name, label, super_class, physical_name, is_extendable, number_prefix, audit FROM sys_db_object`,
      ),
      await db.query<DictRow>(
        `SELECT sys_id, name, element, column_label, internal_type, reference, max_length, mandatory,
                default_value, column_name, active, display, read_only
           FROM sys_dictionary ORDER BY sys_created_on, element`,
      ),
      await db.query<ChoiceRow>(
        `SELECT name, element, value, label, sequence FROM sys_choice
          WHERE inactive IS NOT TRUE ORDER BY sequence NULLS LAST, label`,
      ),
    ];

    const rowsById = new Map(tablesRes.rows.map((r) => [r.sys_id, r]));
    const tables = new Map<string, TableMeta>();
    for (const r of tablesRes.rows) {
      tables.set(r.name, {
        sysId: r.sys_id,
        name: r.name,
        label: r.label ?? r.name,
        superClass: r.super_class ? (rowsById.get(r.super_class)?.name ?? null) : null,
        root: r.name,
        physical: r.physical_name ?? r.name,
        extendable: r.is_extendable !== false,
        numberPrefix: r.number_prefix ?? null,
        audit: r.audit !== false,
        ownFields: new Map(),
        children: [],
      });
    }
    for (const t of tables.values()) {
      let cursor = t;
      const seen = new Set<string>();
      while (cursor.superClass && tables.has(cursor.superClass) && !seen.has(cursor.name)) {
        seen.add(cursor.name);
        cursor = tables.get(cursor.superClass)!;
      }
      t.root = cursor.name;
      if (t.superClass) tables.get(t.superClass)?.children.push(t.name);
    }

    const choices = new Map<string, ChoiceMeta[]>();
    for (const c of choiceRes.rows) {
      const key = `${c.name}.${c.element}`;
      const list = choices.get(key) ?? [];
      list.push({ value: c.value, label: c.label, sequence: c.sequence ?? 0 });
      choices.set(key, list);
    }

    for (const d of dictRes.rows) {
      const t = tables.get(d.name);
      if (!t) continue;
      t.ownFields.set(d.element, {
        sysId: d.sys_id,
        table: d.name,
        element: d.element,
        label: d.column_label ?? d.element,
        type: d.internal_type as FieldType,
        reference: d.reference ?? null,
        maxLength: d.max_length ?? null,
        mandatory: d.mandatory === true,
        defaultValue: d.default_value ?? null,
        column: d.column_name ?? d.element,
        active: d.active !== false,
        display: d.display === true,
        readOnly: d.read_only === true,
        system: false,
        choices: choices.get(`${d.name}.${d.element}`) ?? [],
      });
    }

    this.tables = tables;
    this.bySysId = new Map([...tables.values()].map((t) => [t.sysId, t]));
    this.fieldCache.clear();
    this.version++;
  }

  hasTable(name: string): boolean {
    return this.tables.has(name);
  }

  getTable(name: string): TableMeta {
    const t = this.tables.get(name);
    if (!t) throw new NotFoundError(`Invalid table ${name}`);
    return t;
  }

  getTableBySysId(sysId: string): TableMeta | undefined {
    return this.bySysId.get(sysId);
  }

  listTables(): TableMeta[] {
    return [...this.tables.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Self first, then parent, grandparent, ... root. */
  ancestors(name: string): TableMeta[] {
    const chain: TableMeta[] = [];
    let cursor: TableMeta | undefined = this.getTable(name);
    while (cursor && !chain.includes(cursor)) {
      chain.push(cursor);
      cursor = cursor.superClass ? this.tables.get(cursor.superClass) : undefined;
    }
    return chain;
  }

  /** Self plus all (transitive) child tables. */
  descendants(name: string): string[] {
    const out: string[] = [];
    const queue = [name];
    while (queue.length) {
      const n = queue.shift()!;
      if (out.includes(n)) continue;
      out.push(n);
      queue.push(...(this.tables.get(n)?.children ?? []));
    }
    return out;
  }

  /** All active fields visible on a table: system fields, inherited fields (root first), own fields. */
  fields(name: string): Map<string, FieldMeta> {
    const cached = this.fieldCache.get(name);
    if (cached) return cached;
    const chain = this.ancestors(name).reverse();
    const root = chain[0]!;
    const out = new Map<string, FieldMeta>();
    for (const s of SYSTEM_FIELDS) {
      out.set(s.element, {
        sysId: null,
        table: root.name,
        element: s.element,
        label: s.label,
        type: s.type,
        reference: null,
        maxLength: null,
        mandatory: false,
        defaultValue: null,
        column: s.element,
        active: true,
        display: false,
        readOnly: true,
        system: true,
        choices: [],
      });
    }
    for (const t of chain) {
      for (const f of t.ownFields.values()) if (f.active) out.set(f.element, f);
    }
    this.fieldCache.set(name, out);
    return out;
  }

  field(table: string, element: string): FieldMeta {
    const f = this.fields(table).get(element);
    if (!f) throw new ValidationError(`Unknown field ${table}.${element}`);
    return f;
  }

  /** Every physical column used anywhere in a hierarchy, including inactive fields. */
  hierarchyColumns(root: string): Set<string> {
    const cols = new Set<string>(SYSTEM_FIELDS.map((s) => s.element));
    for (const t of this.tables.values()) {
      if (t.root !== root) continue;
      for (const f of t.ownFields.values()) cols.add(f.column);
    }
    return cols;
  }

  /** Nearest table (self or ancestor) that defines a number prefix. */
  numberSource(name: string): TableMeta | undefined {
    return this.ancestors(name).find((t) => t.numberPrefix);
  }

  /** Field used as the display value of a record (nearest display=true, else name, number, sys_id). */
  displayField(name: string): FieldMeta {
    const fields = [...this.fields(name).values()];
    const flagged = fields.filter((f) => f.display);
    return (
      flagged[flagged.length - 1] ??
      this.fields(name).get('name') ??
      this.fields(name).get('number') ??
      this.fields(name).get('sys_id')!
    );
  }
}
