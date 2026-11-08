import type { Condition, OrderBy, QueryAst } from '@steward/shared';
import { ValidationError } from '../errors';
import type { MetaService } from '../meta/meta-service';
import type { FieldMeta } from '../meta/types';
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

class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/** Resolves dot-walked paths into LEFT JOINs, reusing joins for shared prefixes. */
class JoinPlanner {
  private readonly joins = new Map<string, { alias: string; sql: string }>();

  constructor(
    private readonly meta: MetaService,
    private readonly base: string,
  ) {}

  resolve(path: string): { field: FieldMeta; expr: string } {
    const parts = path.split('.');
    let table = this.base;
    let alias = 't0';
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      const ref = this.meta.field(table, part);
      if (ref.type !== 'reference' || !ref.reference) {
        throw new ValidationError(`Cannot dot-walk through non-reference field ${table}.${part}`);
      }
      prefix = prefix ? `${prefix}.${part}` : part;
      let join = this.joins.get(prefix);
      if (!join) {
        const target = this.meta.getTable(ref.reference);
        const joinAlias = `t${this.joins.size + 1}`;
        join = {
          alias: joinAlias,
          sql: `LEFT JOIN ${quoteIdent(target.physical)} ${joinAlias} ON ${joinAlias}."sys_id" = ${alias}.${quoteIdent(ref.column)}`,
        };
        this.joins.set(prefix, join);
      }
      alias = join.alias;
      table = ref.reference;
    }
    const field = this.meta.field(table, parts[parts.length - 1]!);
    return { field, expr: `${alias}.${quoteIdent(field.column)}` };
  }

  sql(): string {
    return [...this.joins.values()].map((j) => j.sql).join(' ');
  }
}

const TEXTY = new Set(['string', 'text', 'script', 'choice', 'sys_class_name']);
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

function compileCondition(meta: MetaService, c: Condition, planner: JoinPlanner, params: Params): string {
  const { field, expr } = planner.resolve(c.field);
  const text = `${expr}::text`;
  const isEmpty = `(${expr} IS NULL${isTexty(field) ? ` OR ${expr} = ''` : ''})`;

  switch (c.operator) {
    case '=': {
      if (c.value === '') return isEmpty;
      const lit = literal(field, c.value);
      return lit.ok ? `${expr} = ${params.add(lit.value)}` : 'FALSE';
    }
    case '!=': {
      if (c.value === '') return `NOT ${isEmpty}`;
      const lit = literal(field, c.value);
      return lit.ok ? `${expr} IS DISTINCT FROM ${params.add(lit.value)}` : 'TRUE';
    }
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (isUuidField(field) || field.type === 'json') {
        throw new ValidationError(`Operator ${c.operator} is not supported for ${field.table}.${field.element}`);
      }
      const lit = literal(field, c.value);
      return lit.ok ? `${expr} ${c.operator} ${params.add(lit.value)}` : 'FALSE';
    }
    case 'LIKE':
      return `${text} ILIKE ${params.add(`%${escapeLike(c.value)}%`)}`;
    case 'NOT LIKE':
      return `(${expr} IS NULL OR ${text} NOT ILIKE ${params.add(`%${escapeLike(c.value)}%`)})`;
    case 'STARTSWITH':
      return `${text} ILIKE ${params.add(`${escapeLike(c.value)}%`)}`;
    case 'ENDSWITH':
      return `${text} ILIKE ${params.add(`%${escapeLike(c.value)}`)}`;
    case 'IN':
    case 'NOT IN': {
      const values: unknown[] = [];
      for (const raw of c.value.split(',').map((v) => v.trim()).filter(Boolean)) {
        const lit = literal(field, raw);
        if (lit.ok) values.push(lit.value);
      }
      if (c.operator === 'IN') {
        return values.length ? `${expr} IN (${values.map((v) => params.add(v)).join(', ')})` : 'FALSE';
      }
      return values.length
        ? `(${expr} IS NULL OR ${expr} NOT IN (${values.map((v) => params.add(v)).join(', ')}))`
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
      return `${expr} IN (${meta.descendants(c.value).map((t) => params.add(t)).join(', ')})`;
    }
  }
}

function compileWhere(meta: MetaService, table: string, ast: QueryAst | undefined, planner: JoinPlanner, params: Params): string[] {
  const parts: string[] = [];
  const t = meta.getTable(table);
  if (t.superClass) {
    const classes = meta.descendants(table);
    parts.push(`t0."sys_class_name" IN (${classes.map((c) => params.add(c)).join(', ')})`);
  }
  if (ast && ast.groups.length > 0) {
    const groups = ast.groups.map((group) =>
      group.map((clause) => `(${clause.map((c) => compileCondition(meta, c, planner, params)).join(' OR ')})`).join(' AND '),
    );
    parts.push(groups.length === 1 ? groups[0]! : `(${groups.map((g) => `(${g})`).join(' OR ')})`);
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
  const params = new Params();
  const planner = new JoinPlanner(meta, spec.table);

  const paths = spec.fields?.length ? [...new Set(spec.fields)] : [...meta.fields(spec.table).keys()];
  const columns: CompiledColumn[] = [];
  const selectList: string[] = [];
  for (const path of paths) {
    const { field, expr } = planner.resolve(path);
    columns.push({ path, field });
    selectList.push(`${selectExpr(field, expr)} AS ${quoteAlias(path)}`);
  }

  const where = compileWhere(meta, spec.table, spec.query, planner, params);
  const order = [...(spec.query?.orderBy ?? []), ...(spec.orderBy ?? [])].map(
    (o) => `${planner.resolve(o.field).expr} ${o.desc ? 'DESC' : 'ASC'}`,
  );
  order.push('t0."sys_created_on" ASC', 't0."sys_id" ASC');

  let sql = `SELECT ${selectList.join(', ')} FROM ${quoteIdent(t.physical)} t0`;
  const joins = planner.sql();
  if (joins) sql += ` ${joins}`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ` ORDER BY ${order.join(', ')}`;
  if (spec.limit != null) sql += ` LIMIT ${params.add(spec.limit)}`;
  if (spec.offset) sql += ` OFFSET ${params.add(spec.offset)}`;
  if (spec.forUpdate) sql += ' FOR UPDATE OF t0';

  return { sql, params: params.values, columns };
}

export function compileCount(meta: MetaService, table: string, query?: QueryAst): { sql: string; params: unknown[] } {
  const t = meta.getTable(table);
  const params = new Params();
  const planner = new JoinPlanner(meta, table);
  const where = compileWhere(meta, table, query, planner, params);
  let sql = `SELECT count(*)::int AS count FROM ${quoteIdent(t.physical)} t0`;
  const joins = planner.sql();
  if (joins) sql += ` ${joins}`;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  return { sql, params: params.values };
}
