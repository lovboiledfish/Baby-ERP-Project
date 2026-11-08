import { EncodedQueryError, parseEncodedQuery, type OrderBy, type QueryAst } from '@steward/shared';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db';
import { ConflictError, NotFoundError, ValidationError, toStewardError } from '../errors';
import type { MetaService } from '../meta/meta-service';
import type { FieldMeta } from '../meta/types';
import type { Session } from '../session';
import { isUuid, quoteIdent } from '../util';
import { writeAudit, type AuditEntry } from './audit';
import { coerceValue, sameValue, toAuditString, toDbParam } from './coerce';
import type { HookRegistry, Operation } from './hooks';
import { compileCount, compileSelect, type CompiledColumn } from './query-compiler';

export type RecordValues = Record<string, unknown>;
/** false: raw values; true: display strings; 'all': { value, display_value } per field. */
export type DisplayMode = boolean | 'all';

export interface QueryOptions {
  query?: string | QueryAst;
  fields?: string[];
  orderBy?: OrderBy[];
  limit?: number;
  offset?: number;
  displayValue?: DisplayMode;
}

export interface UpdateOptions {
  /** Optimistic lock: fail with 409 unless the stored sys_mod_count matches. */
  expectedModCount?: number;
}

const MAX_HOOK_DEPTH = 16;

function toAst(query: string | QueryAst | undefined): QueryAst | undefined {
  if (query === undefined) return undefined;
  if (typeof query !== 'string') return query;
  try {
    return parseEncodedQuery(query);
  } catch (e) {
    if (e instanceof EncodedQueryError) throw new ValidationError(e.message);
    throw e;
  }
}

function normalizeRow(row: Record<string, unknown>): RecordValues {
  const out: RecordValues = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}

/**
 * The data engine: the one place where records are read and written.
 * Every access path (REST, GlideRecord, metadata API, later sandboxed scripts)
 * goes through here, so validation, hooks, numbering and audit cannot be bypassed.
 */
export class DataEngine {
  private depth = 0;

  constructor(
    private readonly rootDb: Db,
    readonly meta: MetaService,
    private readonly hooks: HookRegistry,
    private readonly tx?: Db,
  ) {}

  /** Current connection: the transaction when bound to one, otherwise the root DB. */
  get db(): Db {
    return this.tx ?? this.rootDb;
  }

  /** Run fn in a transaction. Nested calls join the outer transaction. */
  async transaction<T>(fn: (engine: DataEngine) => Promise<T>): Promise<T> {
    if (this.tx) return fn(this);
    const metaVersion = this.meta.version;
    try {
      return await this.rootDb.transaction((tx) => fn(new DataEngine(this.rootDb, this.meta, this.hooks, tx)));
    } catch (e) {
      // Metadata may have been reloaded from uncommitted rows; resync with the committed state.
      if (this.meta.version !== metaVersion) await this.meta.load(this.rootDb);
      throw toStewardError(e) ?? e;
    }
  }

  // ---------------------------------------------------------------- reads

  async query(table: string, opts: QueryOptions = {}): Promise<RecordValues[]> {
    const compiled = compileSelect(this.meta, {
      table,
      query: toAst(opts.query),
      fields: opts.fields,
      orderBy: opts.orderBy,
      limit: opts.limit,
      offset: opts.offset,
    });
    const res = await this.run(() => this.db.query(compiled.sql, compiled.params));
    const rows = res.rows.map((r) => normalizeRow(r as Record<string, unknown>));
    return opts.displayValue ? this.applyDisplay(rows, compiled.columns, opts.displayValue) : rows;
  }

  async count(table: string, query?: string | QueryAst): Promise<number> {
    const compiled = compileCount(this.meta, table, toAst(query));
    const res = await this.run(() => this.db.query<{ count: number }>(compiled.sql, compiled.params));
    return res.rows[0]?.count ?? 0;
  }

  async get(table: string, sysId: string, opts: Pick<QueryOptions, 'fields' | 'displayValue'> = {}): Promise<RecordValues | null> {
    if (!isUuid(sysId)) return null;
    const rows = await this.query(table, {
      ...opts,
      query: { groups: [[[{ field: 'sys_id', operator: '=', value: sysId }]]], orderBy: [] },
      limit: 1,
    });
    return rows[0] ?? null;
  }

  // --------------------------------------------------------------- writes

  insert(table: string, values: RecordValues, session: Session): Promise<RecordValues> {
    return this.transaction((e) => e.doInsert(table, values, session));
  }

  update(table: string, sysId: string, values: RecordValues, session: Session, opts: UpdateOptions = {}): Promise<RecordValues> {
    return this.transaction((e) => e.doUpdate(table, sysId, values, session, opts));
  }

  delete(table: string, sysId: string, session: Session): Promise<void> {
    return this.transaction((e) => e.doDelete(table, sysId, session));
  }

  private async doInsert(table: string, values: RecordValues, session: Session): Promise<RecordValues> {
    const t = this.meta.getTable(table);
    const fields = this.meta.fields(table);
    const current: RecordValues = {};

    for (const [key, raw] of Object.entries(values)) {
      if (raw === undefined) continue;
      const f = this.writableField(table, key, fields, true);
      if (f) current[key] = coerceValue(f, raw);
    }
    for (const f of fields.values()) {
      if (!f.system && f.defaultValue != null && !(f.element in current)) current[f.element] = coerceValue(f, f.defaultValue);
    }
    if (fields.has('number') && current.number == null) {
      const source = this.meta.numberSource(table);
      if (source) current.number = await this.nextNumber(source.name);
    }
    const sysId = (current.sys_id as string | null) ?? randomUUID();
    current.sys_id = sysId;

    await this.runHooks('before', 'insert', table, current, session);
    this.recoerce(table, current, {});
    this.checkMandatory(table, current);

    const now = new Date().toISOString();
    const row: Array<[string, unknown]> = [
      ['sys_id', sysId],
      ['sys_class_name', table],
      ['sys_created_on', now],
      ['sys_created_by', session.userName],
      ['sys_updated_on', now],
      ['sys_updated_by', session.userName],
      ['sys_mod_count', 0],
    ];
    for (const [key, value] of Object.entries(current)) {
      const f = fields.get(key)!;
      if (f.system || value === null) continue;
      row.push([f.column, toDbParam(f, value)]);
    }
    await this.db.query(
      `INSERT INTO ${quoteIdent(t.physical)} (${row.map(([c]) => quoteIdent(c)).join(', ')}) ` +
        `VALUES (${row.map((_, i) => `$${i + 1}`).join(', ')})`,
      row.map(([, v]) => v),
    );

    const record = (await this.get(table, sysId))!;
    if (t.audit) {
      const entries: AuditEntry[] = [];
      for (const f of fields.values()) {
        if (f.system || record[f.element] == null) continue;
        entries.push({ table, documentKey: sysId, field: f.element, oldValue: null, newValue: toAuditString(record[f.element]), checkpoint: 0 });
      }
      await writeAudit(this.db, session.userName, entries);
    }
    await this.runHooks('after', 'insert', table, { ...record }, session);
    return record;
  }

  private async doUpdate(table: string, sysId: string, values: RecordValues, session: Session, opts: UpdateOptions): Promise<RecordValues> {
    const t = this.meta.getTable(table);
    const fields = this.meta.fields(table);
    const previous = await this.lockRecord(table, sysId);
    if (opts.expectedModCount !== undefined && opts.expectedModCount !== previous.sys_mod_count) {
      throw new ConflictError(
        `Record ${table}:${sysId} was modified by someone else`,
        `expected sys_mod_count ${opts.expectedModCount}, found ${String(previous.sys_mod_count)}`,
      );
    }

    const current: RecordValues = { ...previous };
    for (const [key, raw] of Object.entries(values)) {
      if (raw === undefined) continue;
      const f = this.writableField(table, key, fields, false);
      if (f) current[key] = coerceValue(f, raw);
    }

    await this.runHooks('before', 'update', table, current, session, previous);
    this.recoerce(table, current, previous);
    this.checkMandatory(table, current);

    const changed = [...fields.values()].filter((f) => !f.system && !sameValue(f, previous[f.element], current[f.element]));
    if (changed.length === 0) return previous;

    const params: unknown[] = [];
    const sets = changed.map((f) => {
      params.push(toDbParam(f, current[f.element]));
      return `${quoteIdent(f.column)} = $${params.length}`;
    });
    params.push(new Date().toISOString(), session.userName, sysId, previous.sys_mod_count);
    const n = params.length;
    const res = await this.db.query(
      `UPDATE ${quoteIdent(t.physical)} SET ${sets.join(', ')}, "sys_updated_on" = $${n - 3}, "sys_updated_by" = $${n - 2}, ` +
        `"sys_mod_count" = "sys_mod_count" + 1 WHERE "sys_id" = $${n - 1} AND "sys_mod_count" = $${n}`,
      params,
    );
    if (res.affectedRows === 0) throw new ConflictError(`Record ${table}:${sysId} was modified by someone else`);

    const record = (await this.get(table, sysId))!;
    if (t.audit) {
      const checkpoint = record.sys_mod_count as number;
      await writeAudit(
        this.db,
        session.userName,
        changed.map((f) => ({
          table,
          documentKey: sysId,
          field: f.element,
          oldValue: toAuditString(previous[f.element]),
          newValue: toAuditString(record[f.element]),
          checkpoint,
        })),
      );
    }
    await this.runHooks('after', 'update', table, { ...record }, session, previous);
    return record;
  }

  private async doDelete(table: string, sysId: string, session: Session): Promise<void> {
    const t = this.meta.getTable(table);
    const previous = await this.lockRecord(table, sysId);
    await this.runHooks('before', 'delete', table, { ...previous }, session, previous);
    await this.db.query(`DELETE FROM ${quoteIdent(t.physical)} WHERE "sys_id" = $1`, [sysId]);
    if (t.audit) {
      await writeAudit(this.db, session.userName, [
        { table, documentKey: sysId, field: 'DELETED', oldValue: JSON.stringify(previous), newValue: null, checkpoint: previous.sys_mod_count as number },
      ]);
    }
    await this.runHooks('after', 'delete', table, { ...previous }, session, previous);
  }

  // -------------------------------------------------------------- helpers

  /** Run a statement, translating SQLSTATE errors (bad literals etc.) into StewardErrors. */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toStewardError(e) ?? e;
    }
  }

  private writableField(table: string, key: string, fields: Map<string, FieldMeta>, isInsert: boolean): FieldMeta | undefined {
    const f = fields.get(key);
    if (!f) throw new ValidationError(`Unknown field ${table}.${key}`);
    if (f.system) return isInsert && key === 'sys_id' ? f : undefined; // system fields are silently ignored
    return f;
  }

  /** Re-validate values that were set or changed since `baseline` (e.g. by before hooks). */
  private recoerce(table: string, current: RecordValues, baseline: RecordValues): void {
    const fields = this.meta.fields(table);
    for (const key of Object.keys(current)) {
      const f = fields.get(key);
      if (!f) throw new ValidationError(`Unknown field ${table}.${key}`);
      if (f.system && key !== 'sys_id') continue;
      if (!(key in baseline) || current[key] !== baseline[key]) current[key] = coerceValue(f, current[key]);
    }
  }

  private checkMandatory(table: string, current: RecordValues): void {
    const missing = [...this.meta.fields(table).values()].filter((f) => !f.system && f.mandatory && current[f.element] == null);
    if (missing.length) {
      throw new ValidationError(`Mandatory fields are missing: ${missing.map((f) => f.element).join(', ')}`);
    }
  }

  private async lockRecord(table: string, sysId: string): Promise<RecordValues> {
    if (!isUuid(sysId)) throw new NotFoundError(`Record ${table}:${sysId} not found`);
    const compiled = compileSelect(this.meta, {
      table,
      query: { groups: [[[{ field: 'sys_id', operator: '=', value: sysId }]]], orderBy: [] },
      limit: 1,
      forUpdate: true,
    });
    const res = await this.db.query(compiled.sql, compiled.params);
    const row = res.rows[0];
    if (!row) throw new NotFoundError(`Record ${table}:${sysId} not found`);
    return normalizeRow(row as Record<string, unknown>);
  }

  private async nextNumber(category: string): Promise<string | null> {
    const res = await this.db.query<{ prefix: string; n: number; digits: number | null }>(
      `UPDATE "sys_number" SET "number" = "number" + 1, "sys_mod_count" = "sys_mod_count" + 1, "sys_updated_on" = now()
        WHERE "category" = $1 RETURNING "prefix", "number" - 1 AS n, "maximum_digits" AS digits`,
      [category],
    );
    const row = res.rows[0];
    return row ? `${row.prefix}${String(row.n).padStart(row.digits ?? 7, '0')}` : null;
  }

  private async runHooks(
    when: 'before' | 'after',
    operation: Operation,
    table: string,
    current: RecordValues,
    session: Session,
    previous?: RecordValues,
  ): Promise<void> {
    if (this.depth >= MAX_HOOK_DEPTH) {
      throw new ValidationError(`Maximum hook recursion depth (${MAX_HOOK_DEPTH}) exceeded on ${table}`);
    }
    this.depth++;
    try {
      await this.hooks.run(this.meta, when, { engine: this, session, table, operation, current, previous });
    } finally {
      this.depth--;
    }
  }

  private async applyDisplay(rows: RecordValues[], columns: CompiledColumn[], mode: DisplayMode): Promise<RecordValues[]> {
    // Batch-resolve reference display values per target table.
    const wanted = new Map<string, Set<string>>();
    for (const col of columns) {
      if (col.field.type !== 'reference' || !col.field.reference) continue;
      for (const row of rows) {
        const v = row[col.path];
        if (typeof v !== 'string') continue;
        const ids = wanted.get(col.field.reference) ?? new Set<string>();
        ids.add(v);
        wanted.set(col.field.reference, ids);
      }
    }
    const labels = new Map<string, string>();
    for (const [target, ids] of wanted) {
      const df = this.meta.displayField(target);
      const found = await this.query(target, {
        query: { groups: [[[{ field: 'sys_id', operator: 'IN', value: [...ids].join(',') }]]], orderBy: [] },
        fields: ['sys_id', df.element],
      });
      for (const r of found) labels.set(`${target}:${String(r.sys_id)}`, displayString(df, r[df.element], labels));
    }

    return rows.map((row) => {
      const out: RecordValues = {};
      for (const col of columns) {
        const value = row[col.path];
        const display = displayString(col.field, value, labels);
        out[col.path] = mode === 'all' ? { value, display_value: display } : display;
      }
      return out;
    });
  }
}

function displayString(field: FieldMeta, value: unknown, labels: Map<string, string>): string {
  if (value === null || value === undefined) return '';
  switch (field.type) {
    case 'reference':
      return labels.get(`${field.reference}:${String(value)}`) ?? '';
    case 'choice':
      return field.choices.find((c) => c.value === value)?.label ?? String(value);
    case 'json':
      return JSON.stringify(value);
    default:
      return String(value);
  }
}
