import type { FieldMeta } from '../meta/types';
import type { MetaService } from '../meta/meta-service';

/** Split a comma/newline separated element list, trimming blanks and duplicates. */
export function parseElements(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const out: string[] = [];
  for (const part of raw.split(/[,\n\r]+/)) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

export interface PathHop {
  /** Table the field is read through. */
  table: string;
  field: FieldMeta;
}

const PATH_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

/**
 * Resolve a (possibly dot-walked) field path such as `opened_by.department.name`
 * against the dictionary. Returns null when any hop is unknown, or walks through a
 * non-reference field. Password fields are never valid list/form elements when dot-walked.
 */
export function resolvePath(meta: MetaService, table: string, path: string): PathHop[] | null {
  if (!PATH_RE.test(path) || !meta.hasTable(table)) return null;
  const parts = path.split('.');
  const hops: PathHop[] = [];
  let current = table;
  for (let i = 0; i < parts.length; i++) {
    const f = meta.fields(current).get(parts[i]!);
    if (!f) return null;
    hops.push({ table: current, field: f });
    if (i < parts.length - 1) {
      if (f.type !== 'reference' || !f.reference || !meta.hasTable(f.reference)) return null;
      current = f.reference;
    }
  }
  if (hops.length > 1 && hops[hops.length - 1]!.field.type === 'password') return null;
  return hops;
}

/** One related list entry: `table.field` (references this record) or `table.field=parent_field` (value match). */
export interface RelatedListRef {
  table: string;
  field: string;
  parentField: string;
}

const RELATED_RE = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)(?:=([a-z][a-z0-9_]*))?$/;

export function parseRelated(entry: string): RelatedListRef | null {
  const m = RELATED_RE.exec(entry.trim());
  if (!m) return null;
  return { table: m[1]!, field: m[2]!, parentField: m[3] ?? 'sys_id' };
}

/** Is `ref` a valid related list for records of `table`? Returns an error message, or null when valid. */
export function relatedListProblem(meta: MetaService, table: string, ref: RelatedListRef): string | null {
  if (!meta.hasTable(ref.table)) return `unknown table ${ref.table}`;
  const f = meta.fields(ref.table).get(ref.field);
  if (!f) return `unknown field ${ref.table}.${ref.field}`;
  if (f.type === 'password' || f.type === 'journal') return `${ref.table}.${ref.field} cannot be used to relate records`;
  if (ref.parentField === 'sys_id') {
    const chain = meta.ancestors(table).map((t) => t.name);
    if (f.type !== 'reference' || !f.reference || !chain.includes(f.reference)) {
      return `${ref.table}.${ref.field} is not a reference to ${table}`;
    }
    return null;
  }
  const pf = meta.fields(table).get(ref.parentField);
  if (!pf) return `unknown field ${table}.${ref.parentField}`;
  if (pf.type === 'password' || pf.type === 'journal') return `${table}.${ref.parentField} cannot be used to relate records`;
  return null;
}

export const VIEW_RE = /^[a-z0-9_]{1,40}$/;

/** Built-in relationships that cannot be expressed as a reference (like ServiceNow's sys_relationship). */
export const BUILTIN_RELATED: Readonly<Record<string, string[]>> = {
  sys_db_object: ['sys_dictionary.name=name', 'sys_choice.name=name'],
};
