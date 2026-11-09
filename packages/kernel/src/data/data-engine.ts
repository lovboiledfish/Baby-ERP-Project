import { EncodedQueryError, parseEncodedQuery, type OrderBy, type QueryAst } from '@steward/shared';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, toStewardError } from '../errors';
import type { MetaService } from '../meta/meta-service';
import type { FieldMeta } from '../meta/types';
import { matchesRecord } from '../script/match-record';
import type { ScriptService } from '../script/script-service';
import type { AclService } from '../security/acl-service';
import { resolveDynamic } from '../security/dynamic';
import { hashPassword, isPasswordHash } from '../security/password';
import { isScriptedAccess, type AccessDecision, type AclOperation, type ReadAccess, type ScriptedAccess } from '../security/types';
import { SYSTEM_SESSION, systemSession, type Session } from '../session';
import { isUuid, quoteIdent } from '../util';
import { writeAudit, type AuditEntry } from './audit';
import { coerceValue, sameValue, toAuditString, toDbParam } from './coerce';
import type { HookRegistry, Operation } from './hooks';
import { compileCount, compileRowCheck, compileSelect, type CompiledColumn } from './query-compiler';

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
  /**
   * Who is reading. Omitted = system context (no ACLs), which is what platform
   * internals use. User-facing entry points must always pass the caller's session.
   */
  session?: Session;
}

export interface InsertOptions {
  /** Run user-defined business rules (default: true). System hooks always run. */
  workflow?: boolean;
}

export interface UpdateOptions {
  /** Optimistic lock: fail with 409 unless the stored sys_mod_count matches. */
  expectedModCount?: number;
  /** Run user-defined business rules (default: true). System hooks always run. */
  workflow?: boolean;
}

export interface DeleteOptions {
  /** Run user-defined business rules (default: true). System hooks always run. */
  workflow?: boolean;
}

interface TxState {
  depth: number;
  asyncQueue: Array<(rootEngine: DataEngine) => Promise<void>>;
}

const MAX_HOOK_DEPTH = 16;
const REDACTED = '********';

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

const notFound = (table: string, sysId: string) => new NotFoundError(`Record ${table}:${sysId} not found`);

/**
 * The data engine: the one place where records are read and written.
 * Every access path (REST, GlideRecord, metadata API, sandboxed scripts)
 * goes through here, so ACLs, validation, hooks, business rules, numbering and audit cannot be bypassed.
 */
export class DataEngine {
  private readonly txState: TxState;

  constructor(
    private readonly rootDb: Db,
    readonly meta: MetaService,
     private readonly hooks: HookRegistry,
    readonly acl: AclService,
    readonly scripts?: ScriptService,
    private readonly tx?: Db,
    txState?: TxState,
  ) {
    this.txState = txState ?? { depth: 0, asyncQueue: [] };
  }

  /** Current connection: the transaction when bound to one, otherwise the root DB. */
  get db(): Db {
    return this.tx ?? this.rootDb;
  }

  /**
   * Run fn in a transaction. Nested calls run inside a Postgres SAVEPOINT so that
   * a caught error from a nested write (e.g. inside a script's try/catch) rolls back
   * that nested write cleanly without leaving partial state in the outer transaction.
   */
  async transaction<T>(fn: (engine: DataEngine) => Promise<T>): Promise<T> {
    const metaVersion = this.meta.version;
    const aclVersion = this.acl.version;
    const scriptVersion = this.scripts?.version ?? 0;

    if (this.tx) {
      const asyncLen = this.txState.asyncQueue.length;
      try {
        return await this.tx.transaction(() => fn(this));
      } catch (e) {
        this.txState.asyncQueue.length = asyncLen;
        if (this.meta.version !== metaVersion) await this.meta.load(this.tx);
        if (this.acl.version !== aclVersion) await this.acl.load(this.tx);
        if (this.scripts && this.scripts.version !== scriptVersion) await this.scripts.load(this.tx);
        throw toStewardError(e) ?? e;
      }
    }

    const state: TxState = { depth: 0, asyncQueue: [] };
    try {
      const result = await this.rootDb.transaction((tx) =>
        fn(new DataEngine(this.rootDb, this.meta, this.hooks, this.acl, this.scripts, tx, state)),
      );
      if (state.asyncQueue.length > 0 && this.scripts) {
        this.scripts.enqueueAsync(state.asyncQueue, this);
      }
      return result;
    } catch (e) {
      // Caches may have been reloaded from uncommitted rows; resync with the committed state.
      if (this.meta.version !== metaVersion) await this.meta.load(this.rootDb);
      if (this.acl.version !== aclVersion) await this.acl.load(this.rootDb);
      if (this.scripts && this.scripts.version !== scriptVersion) await this.scripts.load(this.rootDb);
      throw toStewardError(e) ?? e;
    }
  }

  // ---------------------------------------------------------------- reads

  async query(table: string, opts: QueryOptions = {}): Promise<RecordValues[]> {
    const session = opts.session ?? SYSTEM_SESSION;
    const access = this.readAccessFor(session, table);
    const ast = resolveDynamic(toAst(opts.query), session);

    if (access && this.hasScriptedReadAcl(table, ast, opts.fields, opts.orderBy, access)) {
      return this.queryWithScriptedAcl(table, { ...opts, query: ast }, session, access);
    }

    const compiled = compileSelect(this.meta, {
      table,
      query: ast,
      fields: opts.fields,
      orderBy: opts.orderBy,
      limit: opts.limit,
      offset: opts.offset,
      access,
    });
    const res = await this.run(() => this.db.query(compiled.sql, compiled.params));
    const rows = res.rows.map((r) => normalizeRow(r as Record<string, unknown>));
    return opts.displayValue ? this.applyDisplay(rows, compiled.columns, opts.displayValue, session) : rows;
  }

  async count(table: string, query?: string | QueryAst, session: Session = SYSTEM_SESSION): Promise<number> {
    const access = this.readAccessFor(session, table);
    const ast = resolveDynamic(toAst(query), session);

    if (access && this.hasScriptedReadAcl(table, ast, ['sys_id'], undefined, access)) {
      const rows = await this.survivingScriptedRows(table, ast, undefined, ['sys_id'], session, access);
      return rows.rows.length;
    }

    const compiled = compileCount(this.meta, table, ast, access);
    const res = await this.run(() => this.db.query<{ count: number }>(compiled.sql, compiled.params));
    return res.rows[0]?.count ?? 0;
  }

  async get(table: string, sysId: string, opts: Pick<QueryOptions, 'fields' | 'displayValue' | 'session'> = {}): Promise<RecordValues | null> {
    if (!isUuid(sysId)) return null;
    const rows = await this.query(table, {
      ...opts,
      query: { groups: [[[{ field: 'sys_id', operator: '=', value: sysId }]]], orderBy: [] },
      limit: 1,
    });
    return rows[0] ?? null;
  }

  /** Whether `session` may perform `operation` on an existing record (table-level ACLs only). */
  async canAccess(table: string, sysId: string, operation: AclOperation, session: Session): Promise<boolean> {
    if (session.system) return true;
    return this.matches(table, sysId, this.acl.tableDecision(session, table, operation));
  }

  // --------------------------------------------------------------- writes

  insert(table: string, values: RecordValues, session: Session, opts: InsertOptions = {}): Promise<RecordValues> {
    return this.transaction((e) => e.doInsert(table, values, session, opts));
  }

  update(table: string, sysId: string, values: RecordValues, session: Session, opts: UpdateOptions = {}): Promise<RecordValues> {
    return this.transaction((e) => e.doUpdate(table, sysId, values, session, opts));
  }

  delete(table: string, sysId: string, session: Session, opts: DeleteOptions = {}): Promise<void> {
    return this.transaction((e) => e.doDelete(table, sysId, session, opts));
  }

  private async doInsert(table: string, values: RecordValues, session: Session, opts: InsertOptions): Promise<RecordValues> {
    const t = this.meta.getTable(table);
    const fields = this.meta.fields(table);
    const current: RecordValues = {};

    // Conditional and scripted ACLs are checked against the inserted row, inside the transaction.
    const rowChecks: Array<{ decision: AccessDecision; what: string }> = [];
    if (!session.system) {
      const d = this.acl.tableDecision(session, table, 'create');
      if (d === false) throw new ForbiddenError(`Not authorized to create ${table} records`);
      if (d !== true) rowChecks.push({ decision: d, what: `create this ${table} record` });
    }

    for (const [key, raw] of Object.entries(values)) {
      if (raw === undefined) continue;
      const f = this.writableField(table, key, fields, true);
      if (f) current[key] = coerceValue(f, raw);
    }
    if (!session.system) {
      for (const key of Object.keys(current)) {
        const f = fields.get(key)!;
        if (f.system || current[key] === null) continue;
        const d = this.acl.fieldDecision(session, table, key, 'create');
        if (d === false) throw new ForbiddenError(`Not authorized to set ${table}.${key}`);
        if (d !== true) rowChecks.push({ decision: d, what: `set ${table}.${key}` });
      }
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

    await this.runHooks('before', 'insert', table, current, session, undefined, opts.workflow);
    this.recoerce(table, current, {});
    await this.hashPasswords(table, current);
    this.checkMandatory(table, current, true);
    const journal = this.takeJournal(table, current);

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
    for (const check of rowChecks) {
      if (!(await this.matches(table, sysId, check.decision))) throw new ForbiddenError(`Not authorized to ${check.what}`);
    }
    await this.writeJournal(table, sysId, journal, session);

    const record = (await this.get(table, sysId))!;
    if (t.audit) {
      const entries: AuditEntry[] = [];
      for (const f of fields.values()) {
        if (f.system || record[f.element] == null) continue;
        entries.push({ table, documentKey: sysId, field: f.element, oldValue: null, newValue: toAuditString(record[f.element]), checkpoint: 0 });
      }
      await writeAudit(this.db, session.userName, entries);
    }
    await this.runHooks('after', 'insert', table, { ...record }, session, undefined, opts.workflow);
    return this.visibleRecord(table, sysId, record, session);
  }

  private async doUpdate(table: string, sysId: string, values: RecordValues, session: Session, opts: UpdateOptions): Promise<RecordValues> {
    const t = this.meta.getTable(table);
    const fields = this.meta.fields(table);
    const previous = await this.lockRecord(table, sysId);
    if (!session.system) {
      if (!(await this.canAccess(table, sysId, 'read', session))) throw notFound(table, sysId);
      if (!(await this.canAccess(table, sysId, 'write', session))) throw new ForbiddenError(`Not authorized to update ${table}:${sysId}`);
    }
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
    if (!session.system) {
      // Only fields the caller actually changes need field-level write access (PUT may echo read-only values).
      for (const key of Object.keys(values)) {
        const f = fields.get(key);
        if (!f || f.system || values[key] === undefined) continue;
        if (f.type !== 'password' && sameValue(f, previous[key], current[key])) continue;
        if (!(await this.matches(table, sysId, this.acl.fieldDecision(session, table, key, 'write')))) {
          throw new ForbiddenError(`Not authorized to change ${table}.${key}`);
        }
      }
    }

    await this.runHooks('before', 'update', table, current, session, previous, opts.workflow);
    this.recoerce(table, current, previous);
    await this.hashPasswords(table, current);
    this.checkMandatory(table, current, false);
    const journal = this.takeJournal(table, current);

    const changed = [...fields.values()].filter((f) => !f.system && !sameValue(f, previous[f.element], current[f.element]));
    if (changed.length === 0 && journal.length === 0) return this.visibleRecord(table, sysId, previous, session);

    const params: unknown[] = [];
    const sets = changed.map((f) => {
      params.push(toDbParam(f, current[f.element]));
      return `${quoteIdent(f.column)} = $${params.length}`;
    });
    params.push(new Date().toISOString(), session.userName, sysId, previous.sys_mod_count);
    const n = params.length;
    sets.push(`"sys_updated_on" = $${n - 3}`, `"sys_updated_by" = $${n - 2}`, `"sys_mod_count" = "sys_mod_count" + 1`);
    const res = await this.db.query(
      `UPDATE ${quoteIdent(t.physical)} SET ${sets.join(', ')} WHERE "sys_id" = $${n - 1} AND "sys_mod_count" = $${n}`,
      params,
    );
    if (res.affectedRows === 0) throw new ConflictError(`Record ${table}:${sysId} was modified by someone else`);
    await this.writeJournal(String(previous.sys_class_name ?? table), sysId, journal, session);

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
          oldValue: f.type === 'password' ? null : toAuditString(previous[f.element]),
          newValue: f.type === 'password' ? REDACTED : toAuditString(record[f.element]),
          checkpoint,
        })),
      );
    }
    await this.runHooks('after', 'update', table, { ...record }, session, previous, opts.workflow);
    return this.visibleRecord(table, sysId, record, session);
  }

  private async doDelete(table: string, sysId: string, session: Session, opts: DeleteOptions): Promise<void> {
    const t = this.meta.getTable(table);
    const previous = await this.lockRecord(table, sysId);
    if (!session.system) {
      if (!(await this.canAccess(table, sysId, 'read', session))) throw notFound(table, sysId);
      if (!(await this.canAccess(table, sysId, 'delete', session))) throw new ForbiddenError(`Not authorized to delete ${table}:${sysId}`);
    }
    await this.runHooks('before', 'delete', table, { ...previous }, session, previous, opts.workflow);
    await this.db.query(`DELETE FROM ${quoteIdent(t.physical)} WHERE "sys_id" = $1`, [sysId]);
    if (t.audit) {
      await writeAudit(this.db, session.userName, [
        { table, documentKey: sysId, field: 'DELETED', oldValue: JSON.stringify(previous), newValue: null, checkpoint: previous.sys_mod_count as number },
      ]);
    }
    await this.runHooks('after', 'delete', table, { ...previous }, session, previous, opts.workflow);
  }

  // -------------------------------------------------------------- helpers

  /** Read ACLs for a query; throws 403 when the table is not readable at all. */
  private readAccessFor(session: Session, table: string) {
    const access = this.acl.readAccess(session);
    if (access && access.rows(table) === false) throw new ForbiddenError(`Not authorized to read ${table}`);
    return access;
  }

  /**
   * Does record `sysId` satisfy an access decision?
   * Pure condition decisions run in SQL; scripted decisions evaluate each clause's
   * condition + sandboxed script against the record.
   */
  async matches(table: string, sysId: string, decision: AccessDecision): Promise<boolean> {
    if (decision === true) return true;
    if (decision === false) return false;
    if (Array.isArray(decision)) {
      const check = compileRowCheck(this.meta, table, sysId, decision);
      const res = await this.run(() => this.db.query(check.sql, check.params));
      return res.rows.length > 0;
    }
    const row = await this.get(table, sysId);
    if (!row) return false;
    return this.matchesScripted(table, row, decision);
  }

  private async matchesScripted(table: string, row: RecordValues, decision: ScriptedAccess): Promise<boolean> {
    for (const clause of decision.clauses) {
      if (clause.condition) {
        const condOk = await matchesRecord(this, table, row, clause.condition, decision.session);
        if (!condOk) continue;
      }
      if (!clause.script) return true;
      if (!this.scripts) continue;
      const scriptOk = await this.scripts.evalAcl(this, table, row, clause.script, decision.session, clause.name);
      if (scriptOk) return true;
    }
    return false;
  }

  private hasScriptedReadAcl(
    table: string,
    ast: QueryAst | undefined,
    fields: string[] | undefined,
    orderBy: OrderBy[] | undefined,
    access: ReadAccess,
  ): boolean {
    if (isScriptedAccess(access.rows(table))) return true;

    const paths = new Set<string>();
    const selectPaths = fields?.length
      ? fields
      : [...this.meta.fields(table).values()].filter((f) => f.type !== 'password').map((f) => f.element);
    for (const p of selectPaths) paths.add(p);
    if (ast) {
      for (const g of ast.groups) for (const cl of g) for (const c of cl) paths.add(c.field);
      for (const o of ast.orderBy) paths.add(o.field);
    }
    for (const o of orderBy ?? []) paths.add(o.field);

    for (const path of paths) {
      const parts = path.split('.');
      let cur = table;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if (!this.meta.hasTable(cur)) break;
        const f = this.meta.fields(cur).get(part);
        if (!f) break;
        if (isScriptedAccess(access.field(cur, part))) return true;
        if (i < parts.length - 1) {
          if (f.type !== 'reference' || !f.reference) break;
          if (isScriptedAccess(access.rows(f.reference))) return true;
          cur = f.reference;
        }
      }
    }
    return false;
  }

  private async survivingScriptedRows(
    table: string,
    ast: QueryAst | undefined,
    orderBy: OrderBy[] | undefined,
    fields: string[] | undefined,
    session: Session,
    access: ReadAccess,
  ): Promise<{ rows: RecordValues[]; fullRows: RecordValues[]; columns: CompiledColumn[] }> {
    // 1. Compile user's spec to validate all fields, filters, and sorts against unconditional ACL denials.
    const specCompiled = compileSelect(this.meta, {
      table,
      query: ast,
      fields,
      orderBy,
      access,
    });

    // 2. Fetch candidate rows without LIMIT/OFFSET, ensuring all base table columns are present for `current`.
    const baseFields = [...this.meta.fields(table).values()].filter((f) => f.type !== 'password').map((f) => f.element);
    const wantedPaths = [...new Set([...baseFields, ...specCompiled.columns.map((c) => c.path)])];
    const fullCompiled = compileSelect(this.meta, {
      table,
      query: ast,
      fields: wantedPaths,
      orderBy,
      access,
    });
    const res = await this.run(() => this.db.query(fullCompiled.sql, fullCompiled.params));
    const candidates = res.rows.map((r) => normalizeRow(r as Record<string, unknown>));

    // Also fetch unmasked base rows when the query filters on a field with a scripted read ACL or scripted row ACL.
    const rawById = new Map<string, RecordValues>();
    if (candidates.length > 0) {
      const ids = candidates.map((r) => String(r.sys_id)).filter(isUuid);
      if (ids.length > 0) {
        const rawRows = await this.query(table, {
          query: { groups: [[[{ field: 'sys_id', operator: 'IN', value: ids.join(',') }]]], orderBy: [] },
        });
        for (const r of rawRows) rawById.set(String(r.sys_id), r);
      }
    }

    const rowCache = new Map<string, boolean>();
    const canReadRow = async (tbl: string, r: RecordValues): Promise<boolean> => {
      const d = access.rows(tbl);
      if (d === true) return true;
      if (d === false) return false;
      const key = `${tbl}:${String(r.sys_id)}`;
      if (rowCache.has(key)) return rowCache.get(key)!;
      const ok = Array.isArray(d)
        ? await this.matches(tbl, String(r.sys_id), d)
        : await this.matchesScripted(tbl, r, d);
      rowCache.set(key, ok);
      return ok;
    };

    const fieldCache = new Map<string, boolean>();
    const canReadField = async (tbl: string, el: string, r: RecordValues): Promise<boolean> => {
      const d = access.field(tbl, el);
      if (d === true) return true;
      if (d === false) return false;
      const key = `${tbl}.${el}:${String(r.sys_id)}`;
      if (fieldCache.has(key)) return fieldCache.get(key)!;
      const ok = Array.isArray(d)
        ? await this.matches(tbl, String(r.sys_id), d)
        : await this.matchesScripted(tbl, r, d);
      fieldCache.set(key, ok);
      return ok;
    };

    const surviving: RecordValues[] = [];
    const survivingFull: RecordValues[] = [];
    for (const candidate of candidates) {
      const sysId = String(candidate.sys_id);
      const full = rawById.get(sysId) ?? candidate;
      if (!(await canReadRow(table, full))) continue;
      if (ast && ast.groups.length > 0) {
        const filterOk = await matchesRecord(this, table, full, ast, session, { canReadField, canReadRow });
        if (!filterOk) continue;
      }
      surviving.push(candidate);
      survivingFull.push(full);
    }

    return { rows: surviving, fullRows: survivingFull, columns: specCompiled.columns };
  }

  private async queryWithScriptedAcl(
    table: string,
    opts: QueryOptions & { query?: QueryAst },
    session: Session,
    access: ReadAccess,
  ): Promise<RecordValues[]> {
    const { rows, fullRows, columns } = await this.survivingScriptedRows(
      table,
      opts.query,
      opts.orderBy,
      opts.fields,
      session,
      access,
    );

    const offset = opts.offset && opts.offset > 0 ? opts.offset : 0;
    const end = opts.limit != null ? offset + opts.limit : undefined;
    const slicedRows = rows.slice(offset, end);
    const slicedFull = fullRows.slice(offset, end);

    const refCache = new Map<string, RecordValues | null>();
    const loadRef = async (refTable: string, id: string): Promise<RecordValues | null> => {
      const key = `${refTable}:${id}`;
      if (refCache.has(key)) return refCache.get(key)!;
      const r = await this.get(refTable, id);
      refCache.set(key, r);
      return r;
    };

    const pathVisibleOnRow = async (path: string, baseRow: RecordValues): Promise<boolean> => {
      const parts = path.split('.');
      let curTable = table;
      let curRow: RecordValues | null = baseRow;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        const f = this.meta.field(curTable, part);
        const fd = access.field(curTable, part);
        if (fd === false) return false;
        if (isScriptedAccess(fd)) {
          if (!curRow || !(await this.matchesScripted(curTable, curRow, fd))) return false;
        }
        if (i < parts.length - 1) {
          const nextId = curRow ? curRow[part] : null;
          if (!f.reference || typeof nextId !== 'string' || !isUuid(nextId)) return true;
          curRow = await loadRef(f.reference, nextId);
          if (!curRow) return true;
          const rd = access.rows(f.reference);
          if (rd === false) return false;
          if (isScriptedAccess(rd) && !(await this.matchesScripted(f.reference, curRow, rd))) return false;
          curTable = f.reference;
        }
      }
      return true;
    };

    const projected: RecordValues[] = [];
    for (let i = 0; i < slicedRows.length; i++) {
      const candidate = slicedRows[i]!;
      const full = slicedFull[i]!;
      const out: RecordValues = {};
      for (const col of columns) {
        const visible = await pathVisibleOnRow(col.path, full);
        out[col.path] = visible ? (candidate[col.path] ?? null) : null;
      }
      projected.push(out);
    }

    return opts.displayValue ? this.applyDisplay(projected, columns, opts.displayValue, session) : projected;
  }

  /** What a write returns to its caller: the record as the caller is allowed to read it. */
  private async visibleRecord(table: string, sysId: string, record: RecordValues, session: Session): Promise<RecordValues> {
    if (session.system) return record;
    if (this.acl.tableDecision(session, table, 'read') === false) return { sys_id: sysId };
    return (await this.get(table, sysId, { session })) ?? { sys_id: sysId };
  }

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

  /** Re-validate values that were set or changed since `baseline` (e.g. by before hooks or business rules). */
  private recoerce(table: string, current: RecordValues, baseline: RecordValues): void {
    const fields = this.meta.fields(table);
    for (const key of Object.keys(current)) {
      const f = fields.get(key);
      if (!f) throw new ValidationError(`Unknown field ${table}.${key}`);
      if (f.system && key !== 'sys_id') continue;
      if (!(key in baseline) || current[key] !== baseline[key]) current[key] = coerceValue(f, current[key]);
    }
  }

  /** One-way hash any plaintext password values (already-hashed values are kept). */
  private async hashPasswords(table: string, current: RecordValues): Promise<void> {
    for (const f of this.meta.fields(table).values()) {
      const v = current[f.element];
      if (f.type === 'password' && typeof v === 'string' && !isPasswordHash(v)) current[f.element] = await hashPassword(v);
    }
  }

  private checkMandatory(table: string, current: RecordValues, isInsert: boolean): void {
    const missing = [...this.meta.fields(table).values()].filter(
      // Password values are never loaded back and journal fields are always empty when
      // read, so "mandatory" can only be enforced on insert for them.
      (f) =>
        !f.system &&
        f.mandatory &&
        (current[f.element] == null || (f.type === 'journal' && String(current[f.element]).trim() === '')) &&
        (isInsert || (f.type !== 'password' && f.type !== 'journal')),
    );
    if (missing.length) {
      throw new ValidationError(`Mandatory fields are missing: ${missing.map((f) => f.element).join(', ')}`);
    }
  }

  /**
   * Remove journal values from `current`: journal fields (work notes, comments) are
   * never stored in their column; each non-blank value becomes a sys_journal_field entry.
   */
  private takeJournal(table: string, current: RecordValues): Array<{ element: string; value: string }> {
    const entries: Array<{ element: string; value: string }> = [];
    for (const f of this.meta.fields(table).values()) {
      if (f.type !== 'journal' || !(f.element in current)) continue;
      const v = current[f.element];
      current[f.element] = null;
      if (typeof v === 'string' && v.trim() !== '') entries.push({ element: f.element, value: v });
    }
    return entries;
  }

  private async writeJournal(className: string, sysId: string, entries: Array<{ element: string; value: string }>, session: Session): Promise<void> {
    for (const e of entries) {
      await this.doInsert('sys_journal_field', { name: className, element: e.element, element_id: sysId, value: e.value }, systemSession(session.userName), {
        workflow: false,
      });
    }
  }

  private async lockRecord(table: string, sysId: string): Promise<RecordValues> {
    if (!isUuid(sysId)) throw notFound(table, sysId);
    const compiled = compileSelect(this.meta, {
      table,
      query: { groups: [[[{ field: 'sys_id', operator: '=', value: sysId }]]], orderBy: [] },
      limit: 1,
      forUpdate: true,
    });
    const res = await this.db.query(compiled.sql, compiled.params);
    const row = res.rows[0];
    if (!row) throw notFound(table, sysId);
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

  /**
   * Run business rules and system hooks for a write operation.
   *
   * Ordering forms a symmetric middleware wrap around the database write:
   *   before: user `before` business rules -> system `before` hooks (validation & security guards)
   *   after:  system `after` hooks (DDL & cache reload) -> user `after` business rules -> queue `async` rules
   *
   * `workflow = false` (via `setWorkflow(false)`) skips user business rules, never system hooks.
   */
  private async runHooks(
    when: 'before' | 'after',
    operation: Operation,
    table: string,
    current: RecordValues,
    session: Session,
    previous?: RecordValues,
    workflow = true,
  ): Promise<void> {
    if (this.txState.depth >= MAX_HOOK_DEPTH) {
      throw new ValidationError(`Maximum hook recursion depth (${MAX_HOOK_DEPTH}) exceeded on ${table}`);
    }
    this.txState.depth++;
    try {
      if (when === 'before') {
        if (workflow !== false && this.scripts) {
          await this.scripts.runRules(this, 'before', operation, table, current, session, previous);
        }
        await this.hooks.run(this.meta, 'before', { engine: this, session, table, operation, current, previous });
      } else {
        await this.hooks.run(this.meta, 'after', { engine: this, session, table, operation, current, previous });
        if (workflow !== false && this.scripts) {
          await this.scripts.runRules(this, 'after', operation, table, current, session, previous);
          const asyncTask = this.scripts.buildAsyncTask(operation, table, current, session);
          if (asyncTask) this.txState.asyncQueue.push(asyncTask);
        }
      }
    } finally {
      this.txState.depth--;
    }
  }

  private async applyDisplay(rows: RecordValues[], columns: CompiledColumn[], mode: DisplayMode, session: Session): Promise<RecordValues[]> {
    // Batch-resolve reference display values per target table (with the caller's ACLs).
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
      if (!session.system && this.acl.tableDecision(session, target, 'read') === false) continue;
      const df = this.meta.displayField(target);
      const found = await this.query(target, {
        query: { groups: [[[{ field: 'sys_id', operator: 'IN', value: [...ids].join(',') }]]], orderBy: [] },
        fields: ['sys_id', df.element],
        session,
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
