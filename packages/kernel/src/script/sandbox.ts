import { EncodedQueryError, OPERATORS, parseEncodedQuery, type Condition, type Operator, type OrderBy, type QueryAst } from '@steward/shared';
import ivm from 'isolated-vm';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import type { DataEngine, RecordValues } from '../data/data-engine';
import type { Operation } from '../data/hooks';
import { ForbiddenError, StewardError, ValidationError, toStewardError } from '../errors';
import { scriptSession, type Session } from '../session';
import { SANDBOX_PRELUDE } from './prelude';

const OPERATOR_SET: ReadonlySet<string> = new Set(OPERATORS);

export interface ScriptRuntimeOptions {
  /** Maximum CPU / wall-clock execution time per script invocation (default: 5000 ms). */
  timeoutMs?: number;
  /** Maximum V8 heap size per isolate in MiB (default: 64 MiB). */
  memoryLimitMb?: number;
  /** Maximum host bridge calls per script invocation (default: 1000). */
  maxHostCalls?: number;
  /** Maximum idle isolates kept in the pool (default: 4). */
  maxPoolSize?: number;
}

export interface ScriptLogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
  timestamp: string;
}

export interface ScriptMessage {
  type: 'info' | 'error';
  message: string;
}

export interface ScriptRecordBinding {
  table: string;
  values: RecordValues;
  display?: Record<string, string>;
  isNew?: boolean;
  operation?: Operation;
  readOnly?: boolean;
}

export interface ScriptExecRequest {
  /** JavaScript source code to run. */
  script: string;
  /** Virtual filename for stack traces (e.g. `sys_script/CalcPriority.js`). */
  sourceName?: string;
  /** Treat `script` strictly as a single boolean/value expression. */
  expression?: boolean;
  /** Active caller session (determines `gs.getUser*()`, `gs.hasRole()`, and `GlideRecordSecure`). */
  session: Session;
  /** Whether `GlideRecord` (non-secure) keeps the caller's elevated roles (true for background scripts, false for business rules). */
  keepElevatedRoles?: boolean;
  /** Force all `GlideRecord` instances to enforce caller ACLs (used for untrusted user expressions). */
  forceSecure?: boolean;
  /** Disallow all database writes and property mutations (used for ACL scripts and condition expressions). */
  readOnly?: boolean;
  /** Optional `current` record binding. */
  current?: ScriptRecordBinding;
  /** Optional `previous` record binding. */
  previous?: ScriptRecordBinding;
  /** Active Script Includes (`name -> script`) available for lazy loading. */
  includes?: ReadonlyMap<string, string>;
  /** Override the runtime's default timeout for this execution. */
  timeoutMs?: number;
}

export interface ScriptExecResult {
  value: unknown;
  answer: unknown;
  logs: ScriptLogEntry[];
  messages: ScriptMessage[];
  /** Pending field mutations made to `current` (when `current` was provided and not readOnly). */
  pending?: RecordValues;
  /** True when `current.setAbortAction(true)` was called. */
  aborted: boolean;
  durationMs: number;
}

interface ExtractEnvelope {
  value: unknown;
  answer: unknown;
  pending?: RecordValues;
  aborted: boolean;
}

const MAX_LOGS = 500;

/**
 * Check JavaScript syntax before saving a script record or executing it.
 * Supports both top-level statements and top-level `return` statements (ServiceNow style).
 * Returns `'expression' | 'statements' | 'iife'`.
 */
export function checkScriptSyntax(code: string, opts: { expression?: boolean; label?: string } = {}): 'expression' | 'statements' | 'iife' {
  const prefix = opts.label ? `${opts.label}: ` : '';
  if (opts.expression) {
    try {
      new vm.Script(`(\n${code}\n)`);
      return 'expression';
    } catch (e) {
      throw new ValidationError(`${prefix}Syntax error in condition: ${(e as Error).message}`);
    }
  }
  try {
    new vm.Script(code);
    return 'statements';
  } catch (firstErr) {
    const msg = (firstErr as Error).message ?? '';
    if (msg.includes('Illegal return statement')) {
      try {
        new vm.Script(`(function(current, previous){\n${code}\n})`);
        return 'iife';
      } catch (e) {
        throw new ValidationError(`${prefix}Syntax error in script: ${(e as Error).message}`);
      }
    }
    throw new ValidationError(`${prefix}Syntax error in script: ${msg}`);
  }
}

/**
 * Sandboxed V8 isolate pool (`isolated-vm`) with CPU time limits, heap limits,
 * and a synchronous host bridge to the platform's DataEngine.
 *
 * Why a pool: while an isolate is paused inside `applySyncPromise` awaiting a database
 * query or write on the host event loop, a nested business rule or scripted ACL may need
 * to run another script. Acquiring a separate idle isolate from the pool prevents
 * re-entrant deadlocks on the paused isolate.
 */
export class ScriptRuntime {
  readonly timeoutMs: number;
  readonly memoryLimitMb: number;
  readonly maxHostCalls: number;
  private readonly maxPoolSize: number;
  private readonly pool: ivm.Isolate[] = [];
  private closed = false;

  constructor(opts: ScriptRuntimeOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.memoryLimitMb = opts.memoryLimitMb ?? 64;
    this.maxHostCalls = opts.maxHostCalls ?? 1_000;
    this.maxPoolSize = opts.maxPoolSize ?? 4;
  }

  private acquire(): ivm.Isolate {
    while (this.pool.length > 0) {
      const iso = this.pool.pop()!;
      if (!iso.isDisposed) return iso;
    }
    return new ivm.Isolate({ memoryLimit: this.memoryLimitMb });
  }

  private release(iso: ivm.Isolate): void {
    if (iso.isDisposed) return;
    if (this.closed || this.pool.length >= this.maxPoolSize) {
      iso.dispose();
      return;
    }
    this.pool.push(iso);
  }

  close(): void {
    this.closed = true;
    while (this.pool.length > 0) {
      const iso = this.pool.pop()!;
      if (!iso.isDisposed) iso.dispose();
    }
  }

  async run(engine: DataEngine, req: ScriptExecRequest): Promise<ScriptExecResult> {
    const mode = checkScriptSyntax(req.script, { expression: req.expression });
    const timeoutMs = req.timeoutMs ?? this.timeoutMs;
    const started = Date.now();
    const deadline = started + timeoutMs;

    const logs: ScriptLogEntry[] = [];
    const messages: ScriptMessage[] = [];
    const session = req.session;
    const grSession = scriptSession(session, Boolean(req.keepElevatedRoles));
    const readOnly = Boolean(req.readOnly);
    const forceSecure = Boolean(req.forceSecure);
    const includes = req.includes ?? new Map<string, string>();

    let hostCalls = 0;
    let lastHostError: StewardError | null = null;

    const displayName = await this.resolveUserDisplayName(engine, session);
    const initPayload = {
      user: {
        id: session.userId ?? '',
        userName: session.userName,
        displayName,
        groups: [...session.groups],
      },
      includes: [...includes.keys()],
      current: req.current
        ? {
            table: req.current.table,
            values: req.current.values,
            display: req.current.display ?? {},
            displayField: engine.meta.hasTable(req.current.table) ? engine.meta.displayField(req.current.table).element : 'sys_id',
            isNew: Boolean(req.current.isNew),
            operation: req.current.operation ?? null,
            readOnly: Boolean(req.current.readOnly || readOnly),
          }
        : null,
      previous: req.previous
        ? {
            table: req.previous.table,
            values: req.previous.values,
            display: req.previous.display ?? {},
            displayField: engine.meta.hasTable(req.previous.table) ? engine.meta.displayField(req.previous.table).element : 'sys_id',
          }
        : null,
    };

    const hostDispatch = async (op: string, payload: Record<string, unknown> = {}): Promise<unknown> => {
      if (++hostCalls > this.maxHostCalls) {
        const err = new ValidationError(`Maximum script host calls (${this.maxHostCalls}) exceeded`);
        lastHostError = err;
        throw err;
      }
      if (Date.now() > deadline) {
        const err = new ValidationError(`Script timed out after ${timeoutMs}ms`);
        lastHostError = err;
        throw err;
      }
      try {
        return await this.handleHostCall(engine, op, payload, {
          session,
          grSession,
          readOnly,
          forceSecure,
          includes,
          logs,
          messages,
        });
      } catch (e) {
        const mapped = toStewardError(e);
        if (mapped) {
          lastHostError = mapped;
          throw mapped;
        }
        throw e;
      }
    };

    const iso = this.acquire();
    let ctx: ivm.Context | undefined;
    try {
      ctx = await iso.createContext();
      await ctx.global.set('__init', new ivm.ExternalCopy(initPayload).copyInto());
      await ctx.global.set('__host', new ivm.Reference(hostDispatch));
      await ctx.eval(SANDBOX_PRELUDE, { filename: 'steward:prelude.js', timeout: timeoutMs });

      const wrapped = buildRunnerScript(req.script, mode, req.sourceName ?? 'script.js');
      const remaining = Math.max(1, deadline - Date.now());
      const rawJson = (await ctx.eval(wrapped, {
        filename: req.sourceName ?? 'script.js',
        timeout: remaining,
      })) as string;
      const extracted = JSON.parse(rawJson) as ExtractEnvelope;

      return {
        value: extracted.value,
        answer: extracted.answer,
        logs,
        messages,
        pending: extracted.pending,
        aborted: extracted.aborted,
        durationMs: Date.now() - started,
      };
    } catch (e) {
      throw this.mapExecutionError(e, lastHostError, timeoutMs, req.sourceName);
    } finally {
      if (ctx && !iso.isDisposed) {
        try {
          ctx.release();
        } catch {
          // Ignore release errors on a terminated context.
        }
      }
      this.release(iso);
    }
  }

  private async resolveUserDisplayName(engine: DataEngine, session: Session): Promise<string> {
    if (!session.userId) return session.userName;
    try {
      const row = await engine.get('sys_user', session.userId, { fields: ['name', 'user_name'] });
      return String(row?.name || row?.user_name || session.userName);
    } catch {
      return session.userName;
    }
  }

  private async handleHostCall(
    engine: DataEngine,
    op: string,
    payload: Record<string, unknown>,
    ctx: {
      session: Session;
      grSession: Session;
      readOnly: boolean;
      forceSecure: boolean;
      includes: ReadonlyMap<string, string>;
      logs: ScriptLogEntry[];
      messages: ScriptMessage[];
    },
  ): Promise<unknown> {
    switch (op) {
      case 'gs:log': {
        if (ctx.logs.length < MAX_LOGS) {
          const level = (['info', 'warn', 'error', 'debug'] as const).includes(payload.level as never)
            ? (payload.level as ScriptLogEntry['level'])
            : 'info';
          const entry: ScriptLogEntry = {
            level,
            message: String(payload.message ?? ''),
            timestamp: new Date().toISOString(),
          };
          if (typeof payload.source === 'string') entry.source = payload.source;
          ctx.logs.push(entry);
        }
        return null;
      }
      case 'gs:message': {
        const type = payload.type === 'error' ? 'error' : 'info';
        ctx.messages.push({ type, message: String(payload.message ?? '') });
        return null;
      }
      case 'gs:hasRole':
        return engine.acl.hasRole(ctx.session, String(payload.role ?? ''));
      case 'gs:isMemberOf': {
        const group = String(payload.group ?? '').trim();
        if (!group) return false;
        if (ctx.session.groups.has(group)) return true;
        const rows = await engine.query('sys_user_group', {
          query: { groups: [[[{ field: 'name', operator: '=', value: group }]]], orderBy: [] },
          fields: ['sys_id'],
          limit: 1,
        });
        const id = rows[0]?.sys_id;
        return typeof id === 'string' && ctx.session.groups.has(id);
      }
      case 'gs:getProperty': {
        const name = String(payload.name ?? '').trim();
        if (!name) return null;
        const rows = await engine.query('sys_properties', {
          query: { groups: [[[{ field: 'name', operator: '=', value: name }]]], orderBy: [] },
          fields: ['value'],
          limit: 1,
        });
        return rows[0]?.value != null ? String(rows[0].value) : null;
      }
      case 'gs:setProperty': {
        if (ctx.readOnly) throw new ForbiddenError('Cannot modify system properties in a read-only script context');
        const name = String(payload.name ?? '').trim();
        if (!name) throw new ValidationError('Property name is required');
        if (name === 'glide.steward.bootstrap_version') {
          throw new ForbiddenError('Cannot modify system bootstrap version property');
        }
        const value = payload.value == null ? '' : String(payload.value);
        const existing = await engine.query('sys_properties', {
          query: { groups: [[[{ field: 'name', operator: '=', value: name }]]], orderBy: [] },
          fields: ['sys_id'],
          limit: 1,
        });
        if (existing[0]?.sys_id) {
          const updateVals: RecordValues = { value };
          if (payload.description !== undefined) updateVals.description = payload.description;
          await engine.update('sys_properties', String(existing[0].sys_id), updateVals, ctx.grSession);
        } else {
          await engine.insert(
            'sys_properties',
            { name, value, description: payload.description ?? null },
            ctx.grSession,
          );
        }
        return null;
      }
      case 'gs:uuid':
        return randomUUID();
      case 'include:load': {
        const name = String(payload.name ?? '');
        const src = ctx.includes.get(name);
        if (src === undefined) throw new ValidationError(`Script include "${name}" does not exist or is inactive`);
        return src;
      }
      case 'gr:init': {
        const table = String(payload.table ?? '');
        engine.meta.getTable(table);
        const displayField = engine.meta.displayField(table).element;
        return new ivm.ExternalCopy({ displayField }).copyInto();
      }
      case 'gr:query': {
        const table = String(payload.table ?? '');
        const targetSession = payload.secure || ctx.forceSecure ? ctx.session : ctx.grSession;
        const ast = buildQueryAst(payload.clauses, payload.encodedQueries, payload.orderBy);
        const limit = typeof payload.limit === 'number' && Number.isFinite(payload.limit) ? Math.max(0, Math.trunc(payload.limit)) : undefined;
        const rawRows = await engine.query(table, {
          query: ast,
          limit,
          displayValue: 'all',
          session: targetSession,
        });
        const rows = rawRows.map((r) => splitAllRow(r));
        return new ivm.ExternalCopy({ rows }).copyInto();
      }
      case 'gr:insert': {
        if (ctx.readOnly) throw new ForbiddenError('Database writes are not allowed in a read-only script context');
        const table = String(payload.table ?? '');
        const targetSession = payload.secure || ctx.forceSecure ? ctx.session : ctx.grSession;
        const values = (payload.values as RecordValues | undefined) ?? {};
        const workflow = payload.workflow !== false;
        const created = await engine.insert(table, values, targetSession, { workflow });
        const sysId = String(created.sys_id);
        const reloaded = await engine.get(table, sysId, { displayValue: 'all', session: targetSession });
        const formatted = reloaded ? splitAllRow(reloaded) : { values: created, display: {} };
        return new ivm.ExternalCopy(formatted).copyInto();
      }
      case 'gr:update': {
        if (ctx.readOnly) throw new ForbiddenError('Database writes are not allowed in a read-only script context');
        const table = String(payload.table ?? '');
        const sysId = String(payload.sysId ?? '');
        const targetSession = payload.secure || ctx.forceSecure ? ctx.session : ctx.grSession;
        const values = (payload.values as RecordValues | undefined) ?? {};
        const workflow = payload.workflow !== false;
        const updated = await engine.update(table, sysId, values, targetSession, { workflow });
        const reloaded = await engine.get(table, sysId, { displayValue: 'all', session: targetSession });
        const formatted = reloaded ? splitAllRow(reloaded) : { values: updated, display: {} };
        return new ivm.ExternalCopy(formatted).copyInto();
      }
      case 'gr:delete': {
        if (ctx.readOnly) throw new ForbiddenError('Database writes are not allowed in a read-only script context');
        const table = String(payload.table ?? '');
        const sysId = String(payload.sysId ?? '');
        const targetSession = payload.secure || ctx.forceSecure ? ctx.session : ctx.grSession;
        const workflow = payload.workflow !== false;
        await engine.delete(table, sysId, targetSession, { workflow });
        return true;
      }
      default:
        throw new ValidationError(`Unknown host operation "${op}"`);
    }
  }

  private mapExecutionError(err: unknown, lastHostError: StewardError | null, timeoutMs: number, sourceName?: string): StewardError {
    if (err instanceof StewardError) return err;
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    if (lastHostError && msg.includes(lastHostError.message)) {
      return lastHostError;
    }
    const where = sourceName ? ` (${sourceName})` : '';
    if (msg.includes('Script execution timed out')) {
      return new ValidationError(`Script timed out after ${timeoutMs}ms${where}`, stack);
    }
    if (msg.includes('memory limit') || msg.includes('Isolate was disposed during execution')) {
      return new ValidationError(`Script exceeded memory limit (${this.memoryLimitMb}MB)${where}`, stack);
    }
    return new ValidationError(`Script error${where}: ${msg}`, stack);
  }
}

function splitAllRow(row: RecordValues): { values: RecordValues; display: Record<string, string> } {
  const values: RecordValues = {};
  const display: Record<string, string> = {};
  for (const [k, cell] of Object.entries(row)) {
    if (cell && typeof cell === 'object' && 'value' in cell && 'display_value' in cell) {
      const c = cell as { value: unknown; display_value: string };
      values[k] = c.value;
      display[k] = c.display_value;
    } else {
      values[k] = cell;
      display[k] = cell == null ? '' : String(cell);
    }
  }
  return { values, display };
}

function buildQueryAst(rawClauses: unknown, rawEncoded: unknown, rawOrderBy: unknown): QueryAst {
  const ast: QueryAst = { groups: [], orderBy: [] };
  const ensureGroup = (): Condition[][] => {
    if (ast.groups.length === 0) ast.groups.push([]);
    return ast.groups[ast.groups.length - 1]!;
  };

  if (Array.isArray(rawClauses)) {
    for (const clause of rawClauses) {
      if (!Array.isArray(clause) || clause.length === 0) continue;
      const conds: Condition[] = [];
      for (const c of clause) {
        const item = c as { field?: unknown; operator?: unknown; value?: unknown };
        const op = String(item.operator ?? '=');
        if (!OPERATOR_SET.has(op)) throw new ValidationError(`Unknown operator ${op}`);
        conds.push({
          field: String(item.field ?? ''),
          operator: op as Operator,
          value: item.value == null ? '' : String(item.value),
        });
      }
      if (conds.length) ensureGroup().push(conds);
    }
  }

  if (Array.isArray(rawEncoded)) {
    for (const q of rawEncoded) {
      if (typeof q !== 'string' || !q.trim()) continue;
      let parsed: QueryAst;
      try {
        parsed = parseEncodedQuery(q);
      } catch (e) {
        if (e instanceof EncodedQueryError) throw new ValidationError(e.message);
        throw e;
      }
      if (parsed.groups.length > 1 && ast.groups.some((g) => g.length)) {
        throw new ValidationError('Cannot merge a ^NQ query into an existing query');
      }
      if (parsed.groups.length > 1) ast.groups = parsed.groups;
      else if (parsed.groups.length === 1) ensureGroup().push(...parsed.groups[0]!);
      ast.orderBy.push(...parsed.orderBy);
    }
  }

  if (Array.isArray(rawOrderBy)) {
    for (const o of rawOrderBy) {
      const item = o as OrderBy;
      if (item && typeof item.field === 'string') {
        ast.orderBy.push({ field: item.field, desc: Boolean(item.desc) });
      }
    }
  }

  return ast;
}

function buildRunnerScript(code: string, mode: 'expression' | 'statements' | 'iife', sourceName: string): string {
  const toSafe = `
    const __toCopyable = (v, depth = 0) => {
      if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
      if (depth > 4 || typeof v === 'function' || typeof v === 'symbol') return undefined;
      if (v instanceof Date) return v.toISOString();
      if (v instanceof GlideDateTime) return v.getValue();
      if (typeof v === 'object' && typeof v.getTableName === 'function' && typeof v.getUniqueValue === 'function') {
        return undefined;
      }
      if (Array.isArray(v)) return v.map((x) => __toCopyable(x, depth + 1));
      if (typeof v === 'object') {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
          const c = __toCopyable(val, depth + 1);
          if (c !== undefined) out[k] = c;
        }
        return out;
      }
      return undefined;
    };
  `;

  let body: string;
  if (mode === 'expression') {
    body = `const __val = (0, eval)(${JSON.stringify(`(\n${code}\n)\n//# sourceURL=${sourceName}`)});`;
  } else if (mode === 'iife') {
    body = `const __val = (0, eval)(${JSON.stringify(`(function(current, previous){\n${code}\n})(globalThis.current, globalThis.previous)\n//# sourceURL=${sourceName}`)});`;
  } else {
    body = `
      let __val = (0, eval)(${JSON.stringify(`${code}\n//# sourceURL=${sourceName}`)});
      if (globalThis.current) {
        if (typeof globalThis.onBefore === 'function') __val = globalThis.onBefore(globalThis.current, globalThis.previous);
        else if (typeof globalThis.onAfter === 'function') __val = globalThis.onAfter(globalThis.current, globalThis.previous);
        else if (typeof globalThis.onAsync === 'function') __val = globalThis.onAsync(globalThis.current, globalThis.previous);
      }
    `;
  }

  return `(() => {
    ${toSafe}
    ${body}
    const __ext = globalThis.__steward_extract();
    return JSON.stringify({
      value: __toCopyable(__val),
      answer: __toCopyable(__ext.answer),
      pending: __toCopyable(__ext.pending),
      aborted: __ext.aborted,
    });
  })()`;
}
