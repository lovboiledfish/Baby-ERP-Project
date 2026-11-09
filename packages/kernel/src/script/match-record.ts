import type { Condition, QueryAst } from '@steward/shared';
import type { DataEngine, RecordValues } from '../data/data-engine';
import { ValidationError } from '../errors';
import type { FieldMeta } from '../meta/types';
import { resolveDynamic } from '../security/dynamic';
import type { Session } from '../session';
import { isUuid } from '../util';

const TEXTY = new Set(['string', 'text', 'script', 'choice', 'sys_class_name', 'journal']);
const isTexty = (f: FieldMeta) => TEXTY.has(f.type);
const isUuidField = (f: FieldMeta) => f.type === 'reference' || f.type === 'guid';

function toComparable(field: FieldMeta, raw: unknown): { ok: true; value: string | number | boolean | null } | { ok: false } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  switch (field.type) {
    case 'integer':
    case 'decimal': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n) || (field.type === 'integer' && !Number.isInteger(n))) return { ok: false };
      return { ok: true, value: n };
    }
    case 'boolean':
      if (raw === true || raw === 'true' || raw === '1' || raw === 1) return { ok: true, value: true };
      if (raw === false || raw === 'false' || raw === '0' || raw === 0) return { ok: true, value: false };
      return { ok: false };
    case 'reference':
    case 'guid': {
      const s = String(raw);
      return isUuid(s) ? { ok: true, value: s.toLowerCase() } : { ok: false };
    }
    default:
      return { ok: true, value: String(raw) };
  }
}

function parseLiteral(field: FieldMeta, value: string): { ok: true; value: string | number | boolean } | { ok: false } {
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

function evalCondition(engine: DataEngine, c: Condition, field: FieldMeta, rawVal: unknown): boolean {
  const strVal = rawVal === null || rawVal === undefined ? '' : String(rawVal);
  const empty = rawVal === null || rawVal === undefined || (isTexty(field) && strVal === '');

  switch (c.operator) {
    case '=': {
      if (c.value === '') return empty;
      const lit = parseLiteral(field, c.value);
      if (!lit.ok || empty) return false;
      const cur = toComparable(field, rawVal);
      return cur.ok && cur.value === lit.value;
    }
    case '!=': {
      if (c.value === '') return !empty;
      const lit = parseLiteral(field, c.value);
      if (!lit.ok) return true;
      if (empty) return true;
      const cur = toComparable(field, rawVal);
      return !cur.ok || cur.value !== lit.value;
    }
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (isUuidField(field) || field.type === 'json') {
        throw new ValidationError(`Operator ${c.operator} is not supported for ${field.table}.${field.element}`);
      }
      const lit = parseLiteral(field, c.value);
      if (!lit.ok || empty) return false;
      const cur = toComparable(field, rawVal);
      if (!cur.ok || cur.value === null) return false;
      const a = cur.value;
      const b = lit.value;
      if (c.operator === '<') return a < b;
      if (c.operator === '<=') return a <= b;
      if (c.operator === '>') return a > b;
      return a >= b;
    }
    case 'LIKE':
      return !empty && strVal.toLowerCase().includes(c.value.toLowerCase());
    case 'NOT LIKE':
      return rawVal === null || rawVal === undefined || !strVal.toLowerCase().includes(c.value.toLowerCase());
    case 'STARTSWITH':
      return !empty && strVal.toLowerCase().startsWith(c.value.toLowerCase());
    case 'ENDSWITH':
      return !empty && strVal.toLowerCase().endsWith(c.value.toLowerCase());
    case 'IN':
    case 'NOT IN': {
      const values: Array<string | number | boolean> = [];
      for (const item of c.value.split(',').map((v) => v.trim()).filter(Boolean)) {
        const lit = parseLiteral(field, item);
        if (lit.ok) values.push(lit.value);
      }
      if (c.operator === 'IN') {
        if (!values.length || empty) return false;
        const cur = toComparable(field, rawVal);
        return cur.ok && cur.value !== null && values.includes(cur.value);
      }
      if (!values.length || rawVal === null || rawVal === undefined) return true;
      const cur = toComparable(field, rawVal);
      return !cur.ok || cur.value === null || !values.includes(cur.value);
    }
    case 'ISEMPTY':
      return rawVal === null || rawVal === undefined || strVal === '';
    case 'ISNOTEMPTY':
      return rawVal !== null && rawVal !== undefined && strVal !== '';
    case 'INSTANCEOF': {
      if (field.type !== 'sys_class_name') {
        throw new ValidationError(`INSTANCEOF is only valid on sys_class_name fields`);
      }
      if (!engine.meta.hasTable(c.value)) return false;
      return engine.meta.descendants(c.value).includes(strVal);
    }
  }
}

export interface MatchRecordOptions {
  /**
   * Optional per-hop field visibility check (used when post-filtering a user query
   * on a table that has scripted field read ACLs).
   */
  canReadField?: (table: string, element: string, row: RecordValues) => Promise<boolean>;
  /** Optional row readability check for dot-walked target records. */
  canReadRow?: (table: string, row: RecordValues) => Promise<boolean>;
}

/**
 * Evaluate an encoded query `ast` against an in-memory record `current` of `table`.
 * Dot-walked paths (`caller.department.name`) are resolved by loading referenced rows.
 */
export async function matchesRecord(
  engine: DataEngine,
  table: string,
  current: RecordValues,
  ast: QueryAst,
  session: Session,
  opts: MatchRecordOptions = {},
): Promise<boolean> {
  const resolved = resolveDynamic(ast, session);
  if (resolved.groups.length === 0) return true;

  const refCache = new Map<string, RecordValues | null>();
  const loadRef = async (refTable: string, id: string): Promise<RecordValues | null> => {
    const key = `${refTable}:${id}`;
    if (refCache.has(key)) return refCache.get(key)!;
    const row = await engine.get(refTable, id);
    refCache.set(key, row);
    return row;
  };

  const resolveField = async (path: string): Promise<{ ok: true; field: FieldMeta; value: unknown } | { ok: false }> => {
    const parts = path.split('.');
    let curTable = table;
    let curRow: RecordValues | null = { sys_class_name: table, ...current };
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      const refField = engine.meta.field(curTable, part);
      if (refField.type !== 'reference' || !refField.reference) {
        throw new ValidationError(`Cannot dot-walk through non-reference field ${curTable}.${part}`);
      }
      if (opts.canReadField && curRow && !(await opts.canReadField(curTable, part, curRow))) return { ok: false };
      const nextId = curRow ? curRow[part] : null;
      if (typeof nextId === 'string' && isUuid(nextId)) {
        curRow = await loadRef(refField.reference, nextId);
        if (curRow && opts.canReadRow && !(await opts.canReadRow(refField.reference, curRow))) curRow = null;
      } else {
        curRow = null;
      }
      curTable = refField.reference;
    }
    const leaf = parts[parts.length - 1]!;
    const field = engine.meta.field(curTable, leaf);
    if (field.type === 'password') throw new ValidationError(`Password field ${field.table}.${field.element} cannot be read or queried`);
    if (opts.canReadField && curRow && !(await opts.canReadField(curTable, leaf, curRow))) return { ok: false };
    return { ok: true, field, value: curRow ? curRow[leaf] : null };
  };

  for (const group of resolved.groups) {
    let groupOk = true;
    for (const clause of group) {
      let clauseOk = false;
      for (const c of clause) {
        const res = await resolveField(c.field);
        if (res.ok && evalCondition(engine, c, res.field, res.value)) {
          clauseOk = true;
          break;
        }
      }
      if (!clauseOk) {
        groupOk = false;
        break;
      }
    }
    if (groupOk) return true;
  }
  return false;
}
