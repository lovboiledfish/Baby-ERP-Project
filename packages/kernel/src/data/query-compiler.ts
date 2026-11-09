import type { Condition, OrderBy, QueryAst } from '@steward/shared';
import { ForbiddenError, ValidationError } from '../errors';
import type { MetaService } from '../meta/meta-service';
import type { FieldMeta } from '../meta/types';
import type { AccessDecision, ReadAccess } from '../security/types';
import { isUuid, quoteAlias, quoteIdent } from '../util';

export interface SelectSpec {
  table: string;
  query?: QueryAst;
  /** Field paths to select (dot-walking allowed). Defaults to all fields of the table. */
  fields?: string[];
  orderBy?: OrderBy[];
  limit?: number;
  offset?: number;
  /** Lock selected rows of the base table (SELECT ... FOR UPDATE OF t0). */
  forUpdate?: boolean;
  /**
   * Read ACLs to enforce. Omitted = unrestricted (system context). When present:
   * base rows are filtered, dot-walk joins only match readable rows, unreadable
   * fields are dropped from the select list (or masked per row), and querying or
   * sorting on an unreadable field is rejected.
   */
  access?: ReadAccess;
}

export interface CompiledColumn {
  path: string;
  field: FieldMeta;
}

export interface CompiledQuery {
  sql: string;
  params: unknown[];
  columns: CompiledColumn[];
}

/** Shared state for one statement: bind parameters and unique table aliases (also across sub-queries). */
class Ctx {
  readonly values: unknown[] = [];
  private aliasSeq = 0;

  constructor(
    readonly meta: MetaService,
    readonly access?: ReadAccess,
  ) {}

  param(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }

  alias(): string {
    return `t${++this.aliasSeq}`;
  }
}

/** One step of a resolved path: `field` read through `table` (aliased as `alias`). */
interface Hop {
  table: string;
  alias: string;
  field: FieldMeta;
}

interface Resolved {
  field: FieldMeta;
  expr: string;
  hops: Hop[];
}

/** Resolves dot-walked paths into LEFT JOINs, reusing joins for shared prefixes. */
class JoinPlanner {
  private readonly joins = new Map<string, { alias: string; sql: string }>();

  /** @param secure apply ctx.access row filters to joins (false inside trusted ACL predicates). */
  constructor(
    private readonly ctx: Ctx,
    private readonly base: string,
    private readonly baseAlias: string,
    private readonly secure: boolean,
  ) {}

  resolve(path: string): Resolved {
    const { meta } = this.ctx;
    const parts = path.split('.');
    let table = this.base;
    let alias = this.baseAlias;
    let prefix = '';
    const hops: Hop[] = [];
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      const ref = meta.field(table, part);
      if (ref.type !== 'reference' || !ref.reference) {
        throw new ValidationError(`Cannot dot-walk through non-reference field ${table}.${part}`);
      }
      hops.push({ table, alias, field: ref });
      prefix = prefix ? `${prefix}.${part}` : part;
      let join = this.joins.get(prefix);
      if (!join) {
        const target = meta.getTable(ref.reference);
        const joinAlias = this.ctx.alias();
        let on = `${joinAlias}."sys_id" = ${alias}.${quoteIdent(ref.column)}`;
        if (this.secure && this.ctx.access) {
          const filter = decisionSql(this.ctx, ref.reference, joinAlias, this.ctx.access.rows(ref.reference));
          if (filter !== null) on += ` AND ${filter}`;
        }
        join = { alias: joinAlias, sql: `LEFT JOIN ${quoteIdent(target.physical)} ${joinAlias} ON ${on}` };
        this.joins.set(prefix, join);
      }
      alias = join.alias;
      table = ref.reference;
    }
    const field = meta.field(table, parts[parts.length - 1]!);
    if (field.type === 'password') throw new ValidationError(`Password field ${field.table}.${field.element} cannot be read or queried`);
    hops.push({ table, alias, field });
    return { field, expr: `${alias}.${quoteIdent(field.column)}`, hops };
  }

  get hasJoins(): boolean {
    return this.joins.size > 0;
  }

  sql(): string {
    return [...this.joins.values()].map((j) => j.sql).join(' ');
  }
}

const TEXTY = new Set(['string', 'text', 'script', 'choice', 'sys_class_name', 'journal']);
const isTexty = (f: FieldMeta) => TEXTY.has(f.type);
const isUuidField = (f: FieldMeta) => f.type === 'reference' || f.type === 'guid';

function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Convert a query literal into a typed parameter, or null when it can never match (e.g. bad uuid). */
function literal(field: FieldMeta, value: string): { ok: true; value: unknown } | { ok: false } {
  switch (field.type) {
    case 'integer':
    case 'decimal': {
      const n = Number(value);
      if (!Number.isFinite(n) || (field.type === 'integer' && !Number.isInteger(n))) {
        throw new ValidationError(`Invalid numeric value "${value}" for ${field.table}.${field.element}`);
      }
      return { ok: true, value: n };
    }
    case 'boolean':
      if (value === 'true' || value === '1') return { ok: true, value: true };
      if (value === 'false' || value === '0') return { ok: true, value: false };
      throw new ValidationError(`Invalid boolean value "${value}" for ${field.table}.${field.element}`);
    case 'reference':
    case 'guid':
      return isUuid(value) ? { ok: true, value: value.toLowerCase() } : { ok: false };
    default:
      return { ok: true, value };
  }
}

function compileCondition(ctx: Ctx, c: Condition, field: FieldMeta, expr: string): string {
  const { meta } = ctx;
  const text = `${expr}::text`;
  const isEmpty = `(${expr} IS NULL${isTexty(field) ? ` OR ${expr} = ''` : ''})`;

  switch (c.operator) {
    case '=': {
      if (c.value === '') return isEmpty;
      const lit = literal(field, c.value);
      return lit.ok ? `${expr} = ${ctx.param(lit.value)}` : 'FALSE';
    }
    case '!=': {
      if (c.value === '') return `NOT ${isEmpty}`;
      const lit = literal(field, c.value);
      return lit.ok ? `${expr} IS DISTINCT FROM ${ctx.param(lit.value)}` : 'TRUE';
    }
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (isUuidField(field) || field.type === 'json') {
        throw new ValidationError(`Operator ${c.operator} is not supported for ${field.table}.${field.element}`);
      }
      const lit = literal(field, c.value);
      return lit.ok ? `${expr} ${c.operator} ${ctx.param(lit.value)}` : 'FALSE';
    }
    case 'LIKE':
      return `${text} ILIKE ${ctx.param(`%${escapeLike(c.value)}%`)}`;
    case 'NOT LIKE':
      return `(${expr} IS NULL OR ${text} NOT ILIKE ${ctx.param(`%${escapeLike(c.value)}%`)})`;
    case 'STARTSWITH':
      return `${text} ILIKE ${ctx.param(`${escapeLike(c.value)}%`)}`;
    case 'ENDSWITH':
      return `${text} ILIKE ${ctx.param(`%${escapeLike(c.value)}`)}`;
    case 'IN':
    case 'NOT IN': {
      const values: unknown[] = [];
      for (const raw of c.value.split(',').map((v) => v.trim()).filter(Boolean)) {
        const lit = literal(field, raw);
        if (lit.ok) values.push(lit.value);
      }
      if (c.operator === 'IN') {
        return values.length ? `${expr} IN (${values.map((v) => ctx.param(v)).join(', ')})` : 'FALSE';
      }
      return values.length
        ? `(${expr} IS NULL OR ${expr} NOT IN (${values.map((v) => ctx.param(v)).join(', ')}))`
        : 'TRUE';
    }
    case 'ISEMPTY':
      return `(${expr} IS NULL OR ${text} = '')`;
    case 'ISNOTEMPTY':
      return `(${expr} IS NOT NULL AND ${text} <> '')`;
    case 'INSTANCEOF': {
      if (field.type !== 'sys_class_name') {
        throw new ValidationError(`INSTANCEOF is only valid on sys_class_name fields`);
      }
      if (!meta.hasTable(c.value)) return 'FALSE';
      return `${expr} IN (${meta.descendants(c.value).map((t) => ctx.param(t)).join(', ')})`;
    }
  }
}

/**
 * SQL for a field path's visibility: null = always visible, false = never,
 * string = visible only on rows where the predicate holds.
 */
function visibility(ctx: Ctx, secure: boolean, hops: Hop[]): string | null | false {
  if (!secure || !ctx.access) return null;
  const parts: string[] = [];
  for (const hop of hops) {
    const d = ctx.access.field(hop.table, hop.field.element);
    if (d === false) return false;
    const sql = decisionSql(ctx, hop.table, hop.alias, d);
    if (sql !== null) parts.push(sql);
  }
  return parts.length ? parts.join(' AND ') : null;
}

function pathLabel(table: string, path: string): string {
  return `${table}.${path}`;
}

/** AND/OR structure of an AST compiled against a planner. Empty AST -> null. */
function compileGroups(ctx: Ctx, ast: QueryAst, planner: JoinPlanner, table: string, secure: boolean): string | null {
  if (ast.groups.length === 0) return null;
  const groups = ast.groups.map((group) =>
    group
      .map((clause) => {
        const ors = clause.map((c) => {
          const { field, expr, hops } = planner.resolve(c.field);
          const vis = visibility(ctx, secure, hops);
          if (vis === false) throw new ForbiddenError(`Not authorized to query on ${pathLabel(table, c.field)}`);
          const cond = compileCondition(ctx, c, field, expr);
          return vis === null ? cond : `(${vis} AND ${cond})`;
        });
        return `(${ors.join(' OR ')})`;
      })
      .join(' AND '),
  );
  return groups.length === 1 ? groups[0]! : `(${groups.map((g) => `(${g})`).join(' OR ')})`;
}

/**
 * Trusted predicate (an ACL condition) evaluated against the row `alias` of `table`.
 * Conditions with dot-walks become a correlated EXISTS so their joins stay private
 * to the predicate and never mix with the caller's joins.
 */
function predicateSql(ctx: Ctx, table: string, alias: string, ast: QueryAst): string {
  const dotWalks = ast.groups.some((g) => g.some((cl) => cl.some((c) => c.field.includes('.'))));
  if (!dotWalks) {
    return compileGroups(ctx, ast, new JoinPlanner(ctx, table, alias, false), table, false) ?? 'TRUE';
  }
  const sub = ctx.alias();
  const planner = new JoinPlanner(ctx, table, sub, false);
  const where = compileGroups(ctx, ast, planner, table, false) ?? 'TRUE';
  const joins = planner.sql();
  return (
    `EXISTS (SELECT 1 FROM ${quoteIdent(ctx.meta.getTable(table).physical)} ${sub}${joins ? ` ${joins}` : ''} ` +
    `WHERE ${sub}."sys_id" = ${alias}."sys_id" AND ${where})`
  );
}

/** SQL for an access decision on row `alias`: null = no restriction. */
function decisionSql(ctx: Ctx, table: string, alias: string, d: AccessDecision): string | null {
  if (d === true) return null;
  if (d === false || d.length === 0) return 'FALSE';
  const preds = d.map((ast) => predicateSql(ctx, table, alias, ast));
  return preds.length === 1 ? `(${preds[0]})` : `(${preds.map((p) => `(${p})`).join(' OR ')})`;
}

function compileWhere(ctx: Ctx, table: string, ast: QueryAst | undefined, planner: JoinPlanner): string[] {
  const { meta } = ctx;
  const parts: string[] = [];
  const t = meta.getTable(table);
  if (t.superClass) {
    const classes = meta.descendants(table);
    parts.push(`t0."sys_class_name" IN (${classes.map((c) => ctx.param(c)).join(', ')})`);
  }
  if (ctx.access) {
    const rowFilter = decisionSql(ctx, table, 't0', ctx.access.rows(table));
    if (rowFilter !== null) parts.push(rowFilter);
  }
  if (ast) {
    const where = compileGroups(ctx, ast, planner, table, true);
    if (where !== null) parts.push(where);
  }
  return parts;
}

function selectExpr(field: FieldMeta, expr: string): string {
  switch (field.type) {
    case 'date':
      return `${expr}::text`;
    case 'decimal':
      return `${expr}::float8`;
    default:
      return expr;
  }
}

export function compileSelect(meta: MetaService, spec: SelectSpec): CompiledQuery {
  const t = meta.getTable(spec.table);
  const ctx = new Ctx(meta, spec.access);
  const planner = new JoinPlanner(ctx, spec.table, 't0', true);

  const paths = spec.fields?.length
    ? [...new Set(spec.fields)]
    : [...meta.fields(spec.table).values()].filter((f) => f.type !== 'password').map((f) => f.element);
  const columns: CompiledColumn[] = [];
  const selectList: string[] = [];
  for (const path of paths) {
    const { field, expr, hops } = planner.resolve(path);
    const vis = visibility(ctx, true, hops);
    if (vis === false) continue; // unreadable: the column is omitted, as the Table API does
    const value = selectExpr(field, expr);
    columns.push({ path, field });
    selectList.push(`${vis === null ? value : `CASE WHEN ${vis} THEN ${value} END`} AS ${quoteAlias(path)}`);
  }

  const where = compileWhere(ctx, spec.table, spec.query, planner);
  const order = [...(spec.query?.orderBy ?? []), ...(spec.orderBy ?? [])].map((o) => {
    const { expr, hops } = planner.resolve(o.field);
    const vis = visibility(ctx, true, hops);
    if (vis === false) throw new ForbiddenError(`Not authorized to sort on ${pathLabel(spec.table, o.field)}`);
    return `${vis === null ? expr : `CASE WHEN ${vis} THEN ${expr} END`} ${o.desc ? 'DESC' : 'ASC'}`;
  });
  order.push('t0."sys_created_on" ASC', 't0."sys_id" ASC');

  let sql = `SELECT ${selectList.join(', ')} FROM ${quoteIdent(t.physical)} t0`;
  const joins = planner.sql();
  if (joins) sql += ` ${joins}`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ` ORDER BY ${order.join(', ')}`;
  if (spec.limit != null) sql += ` LIMIT ${ctx.param(spec.limit)}`;
  if (spec.offset) sql += ` OFFSET ${ctx.param(spec.offset)}`;
  if (spec.forUpdate) sql += ' FOR UPDATE OF t0';

  return { sql, params: ctx.values, columns };
}

export function compileCount(meta: MetaService, table: string, query?: QueryAst, access?: ReadAccess): { sql: string; params: unknown[] } {
  const t = meta.getTable(table);
  const ctx = new Ctx(meta, access);
  const planner = new JoinPlanner(ctx, table, 't0', true);
  const where = compileWhere(ctx, table, query, planner);
  let sql = `SELECT count(*)::int AS count FROM ${quoteIdent(t.physical)} t0`;
  const joins = planner.sql();
  if (joins) sql += ` ${joins}`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  return { sql, params: ctx.values };
}

/**
 * `SELECT 1` for record `sysId` of `table` if it satisfies an access decision
 * (used to check write/delete/create ACL conditions against a concrete row).
 */
export function compileRowCheck(meta: MetaService, table: string, sysId: string, decision: AccessDecision): { sql: string; params: unknown[] } {
  const t = meta.getTable(table);
  const ctx = new Ctx(meta);
  const id = ctx.param(sysId);
  const filter = decisionSql(ctx, table, 't0', decision);
  return {
    sql: `SELECT 1 AS ok FROM ${quoteIdent(t.physical)} t0 WHERE t0."sys_id" = ${id}${filter === null ? '' : ` AND ${filter}`}`,
    params: ctx.values,
  };
}
