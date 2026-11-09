import type { FieldType } from '@steward/shared';
import { coerceValue } from '../data/coerce';
import type { DataEngine, RecordValues } from '../data/data-engine';
import { ForbiddenError, NotFoundError } from '../errors';
import { describeTable, type FieldDescription } from '../meta/meta-api';
import type { FieldMeta } from '../meta/types';
import type { Session } from '../session';
import { isUuid } from '../util';
import {
  BUILTIN_RELATED,
  parseElements,
  parseRelated,
  relatedListProblem,
  resolvePath,
  VIEW_RE,
  type PathHop,
  type RelatedListRef,
} from './layout';

export interface UiTable {
  name: string;
  label: string;
  extends: string | null;
  /** Ancestors, self first. */
  hierarchy: string[];
  displayField: string;
  numberPrefix: string | null;
}

export interface UiField extends FieldDescription {
  /** For reference fields: the display field of the referenced table (for pickers). */
  referenceDisplayField: string | null;
}

export interface UiColumn {
  path: string;
  label: string;
  type: FieldType;
  reference: string | null;
}

export interface ListLayout {
  table: UiTable;
  view: string;
  /** sys_id of the sys_ui_list record in use, or null for the generated default. */
  layoutId: string | null;
  /** Table the layout record is defined on (may be an ancestor, i.e. inherited). */
  layoutTable: string | null;
  /** View the layout record is defined on (may be "default" when falling back from another view). */
  layoutView: string | null;
  columns: UiColumn[];
  /** Every field the caller may read (condition builder, column picker). */
  fields: UiField[];
  canCreate: boolean;
}

export interface FormSection {
  caption: string;
  elements: string[];
}

export interface RelatedList {
  /** `table.field` or `table.field=parent_field` */
  name: string;
  table: string;
  field: string;
  parentField: string;
  label: string;
}

export interface FormAccess {
  canCreate: boolean;
  canWrite: boolean;
  canDelete: boolean;
  /** Per readable field: may the caller change it on this record (or set it on a new one)? */
  fields: Record<string, { write: boolean }>;
}

export interface FormLayout {
  table: UiTable;
  view: string;
  layoutId: string | null;
  layoutTable: string | null;
  layoutView: string | null;
  /** Configured related list entries (raw), for the layout editor. */
  relatedListConfig: string[];
  fields: UiField[];
  sections: FormSection[];
  relatedLists: RelatedList[];
  access: FormAccess;
  /** `{ value, display_value }` per readable field; defaults for a new record. */
  record: Record<string, { value: unknown; display_value: string }>;
  isNew: boolean;
  /** Actual class of the record when it differs from the requested table (open it as that class). */
  recordClass: string | null;
}

export type ActivityEntry =
  | { type: 'journal'; field: string; label: string; value: string; created_by: string; created_on: string }
  | {
      type: 'audit';
      field: string;
      label: string;
      old_value: string | null;
      new_value: string | null;
      old_display: string | null;
      new_display: string | null;
      created_by: string;
      created_on: string;
    };

const DEFAULT_VIEW = 'default';
const LIST_SKIP_TYPES: ReadonlySet<FieldType> = new Set(['password', 'journal', 'text', 'script', 'json']);
const MAX_DEFAULT_COLUMNS = 6;
const ACTIVITY_LIMIT = 250;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? ''));

/**
 * Builds what the generated UI needs from the dictionary, the layout tables
 * (sys_ui_list / sys_ui_form / sys_ui_section) and the caller's ACLs. Layout rows
 * are platform metadata and are read in system context; everything derived from
 * them is filtered by the caller's field/table ACLs before it is returned.
 */
export class UiService {
  constructor(private readonly engine: DataEngine) {}

  private get meta() {
    return this.engine.meta;
  }

  // ------------------------------------------------------------------ list

  async listLayout(table: string, view: string | undefined, session: Session): Promise<ListLayout> {
    this.assertReadable(table, session);
    const v = normalizeView(view);
    const row = await this.findLayout('sys_ui_list', table, v);
    const readable = parseElements(row?.elements).filter((p) => this.pathReadable(table, p, session));
    const paths = readable.length ? readable : this.defaultColumns(table, session);
    return {
      table: this.uiTable(table),
      view: v,
      layoutId: row ? String(row.sys_id) : null,
      layoutTable: row ? String(row.name) : null,
      layoutView: row ? String(row.view) : null,
      columns: paths.map((p) => this.column(table, p)),
      fields: this.readableFields(table, session),
      canCreate: session.system || this.engine.acl.tableDecision(session, table, 'create') !== false,
    };
  }

  // ------------------------------------------------------------------ form

  async formLayout(table: string, sysId: string | null, view: string | undefined, session: Session): Promise<FormLayout> {
    this.assertReadable(table, session);
    const v = normalizeView(view);
    const isNew = sysId === null || sysId === '-1';
    let record: Record<string, { value: unknown; display_value: string }> = {};
    let recordClass: string | null = null;
    if (!isNew) {
      const found = isUuid(sysId) ? await this.engine.get(table, sysId, { session, displayValue: 'all' }) : null;
      if (!found) throw new NotFoundError('No Record found', `Record ${table}:${sysId} doesn't exist or is not visible`);
      record = found as typeof record;
      const cls = record.sys_class_name?.value;
      if (typeof cls === 'string' && cls !== table && this.meta.hasTable(cls) && (await this.engine.canAccess(cls, sysId, 'read', session))) {
        recordClass = cls;
      }
    }

    let fields = this.readableFields(table, session);
    if (!isNew && !session.system) {
      const visible: UiField[] = [];
      for (const f of fields) {
        if (await this.engine.matches(table, String(sysId), this.engine.acl.fieldDecision(session, table, f.element, 'read'))) visible.push(f);
        else delete record[f.element];
      }
      fields = visible;
    }
    const readable = new Set(fields.map((f) => f.element));
    if (isNew) {
      for (const f of fields) {
        if (f.system || f.defaultValue == null) continue;
        try {
          const value = coerceValue(this.meta.field(table, f.element), f.defaultValue);
          record[f.element] = { value, display_value: displayOf(this.meta.field(table, f.element), value) };
        } catch {
          // An invalid stored default is reported when saving, not when rendering.
        }
      }
    }

    const form = await this.findLayout('sys_ui_form', table, v);
    let sections: FormSection[] = [];
    if (form) {
      const rows = await this.engine.query('sys_ui_section', {
        query: { groups: [[[{ field: 'form', operator: '=', value: String(form.sys_id) }]]], orderBy: [] },
        orderBy: [{ field: 'position', desc: false }],
      });
      sections = rows.map((r) => ({
        caption: String(r.caption ?? ''),
        elements: parseElements(r.elements).filter((e) => !e.includes('.') && readable.has(e)),
      }));
    }
    if (!sections.length) sections = [{ caption: '', elements: this.defaultFormElements(table).filter((e) => readable.has(e)) }];

    const target = isNew ? null : String(sysId);
    return {
      table: this.uiTable(table),
      view: v,
      layoutId: form ? String(form.sys_id) : null,
      layoutTable: form ? String(form.name) : null,
      layoutView: form ? String(form.view) : null,
      relatedListConfig: parseElements(form?.related_lists),
      fields,
      sections,
      relatedLists: isNew ? [] : this.relatedLists(table, form?.related_lists, session),
      access: await this.formAccess(table, target, fields, session),
      record,
      isNew,
      recordClass,
    };
  }

  // -------------------------------------------------------------- activity

  /** Journal entries and audited field changes of one record, newest first, filtered by the caller's ACLs. */
  async activity(table: string, sysId: string, session: Session): Promise<ActivityEntry[]> {
    this.assertReadable(table, session);
    const raw = isUuid(sysId) ? await this.engine.get(table, sysId, { fields: ['sys_class_name'] }) : null;
    if (!raw || !(await this.engine.canAccess(table, sysId, 'read', session))) {
      throw new NotFoundError('No Record found');
    }
    const actualClass = this.meta.hasTable(String(raw.sys_class_name)) ? String(raw.sys_class_name) : table;
    const cls = actualClass !== table && (await this.engine.canAccess(actualClass, sysId, 'read', session)) ? actualClass : table;
    const fields = this.meta.fields(cls);
    const allowed = new Map<string, boolean>();
    const canRead = async (element: string): Promise<boolean> => {
      const cached = allowed.get(element);
      if (cached !== undefined) return cached;
      const f = fields.get(element);
      let ok = !!f && !f.system;
      if (ok && !session.system) ok = await this.engine.matches(cls, sysId, this.engine.acl.fieldDecision(session, cls, element, 'read'));
      allowed.set(element, ok);
      return ok;
    };

    const journal = await this.engine.db.query<{ element: string; value: string | null; sys_created_by: string; sys_created_on: unknown }>(
      `SELECT "element", "value", "sys_created_by", "sys_created_on" FROM "sys_journal_field"
        WHERE "element_id" = $1 ORDER BY "sys_created_on" DESC LIMIT ${ACTIVITY_LIMIT}`,
      [sysId],
    );
    const audit = await this.engine.db.query<{
      fieldname: string;
      oldvalue: string | null;
      newvalue: string | null;
      user: string | null;
      sys_created_on: unknown;
    }>(
      `SELECT "fieldname", "oldvalue", "newvalue", "user", "sys_created_on" FROM "sys_audit"
        WHERE "documentkey" = $1 ORDER BY "sys_created_on" DESC LIMIT ${ACTIVITY_LIMIT}`,
      [sysId],
    );

    const entries: ActivityEntry[] = [];
    for (const j of journal.rows) {
      if (!(await canRead(j.element))) continue;
      entries.push({
        type: 'journal',
        field: j.element,
        label: fields.get(j.element)!.label,
        value: j.value ?? '',
        created_by: j.sys_created_by,
        created_on: iso(j.sys_created_on),
      });
    }
    const audits: Array<{ f: FieldMeta; row: (typeof audit.rows)[number] }> = [];
    for (const a of audit.rows) {
      if (await canRead(a.fieldname)) audits.push({ f: fields.get(a.fieldname)!, row: a });
    }
    const labels = await this.referenceLabels(
      audits.filter((x) => x.f.type === 'reference').flatMap((x) => [x.row.oldvalue, x.row.newvalue].map((v) => [x.f.reference!, v] as const)),
      session,
    );
    for (const { f, row } of audits) {
      const hidden = f.type === 'password';
      const show = (v: string | null) => {
        if (hidden || v == null) return null;
        if (f.type === 'reference') return labels.get(`${f.reference}:${v}`) ?? null;
        if (f.type === 'choice') return f.choices.find((c) => c.value === v)?.label ?? v;
        return v;
      };
      entries.push({
        type: 'audit',
        field: f.element,
        label: f.label,
        old_value: hidden ? null : row.oldvalue,
        new_value: hidden ? null : row.newvalue,
        old_display: show(row.oldvalue),
        new_display: show(row.newvalue),
        created_by: row.user ?? '',
        created_on: iso(row.sys_created_on),
      });
    }
    entries.sort((a, b) => b.created_on.localeCompare(a.created_on));
    return entries.slice(0, ACTIVITY_LIMIT);
  }

  // --------------------------------------------------------------- helpers

  private assertReadable(table: string, session: Session): void {
    this.meta.getTable(table);
    if (!session.system && this.engine.acl.tableDecision(session, table, 'read') === false) {
      throw new ForbiddenError(`Not authorized to read ${table}`);
    }
  }

  private uiTable(table: string): UiTable {
    const t = this.meta.getTable(table);
    return {
      name: t.name,
      label: t.label,
      extends: t.superClass,
      hierarchy: this.meta.ancestors(table).map((a) => a.name),
      displayField: this.meta.displayField(table).element,
      numberPrefix: this.meta.numberSource(table)?.numberPrefix ?? null,
    };
  }

  private readableFields(table: string, session: Session): UiField[] {
    const { acl } = this.engine;
    return describeTable(this.meta, table)
      .fields.filter((f) => session.system || acl.fieldDecision(session, table, f.element, 'read') !== false)
      .map((f) => ({
        ...f,
        referenceDisplayField: f.reference && this.meta.hasTable(f.reference) ? this.meta.displayField(f.reference).element : null,
      }));
  }

  /** A path is shown only if every hop's field (and every joined table) may be read at least on some rows. */
  private pathReadable(table: string, path: string, session: Session): boolean {
    const hops = resolvePath(this.meta, table, path);
    if (!hops) return false;
    if (hops[hops.length - 1]!.field.type === 'password') return false;
    if (session.system) return true;
    const { acl } = this.engine;
    return hops.every(
      (h: PathHop, i) => acl.fieldDecision(session, h.table, h.field.element, 'read') !== false && (i === 0 || acl.tableDecision(session, h.table, 'read') !== false),
    );
  }

  private column(table: string, path: string): UiColumn {
    const hops = resolvePath(this.meta, table, path)!;
    const last = hops[hops.length - 1]!.field;
    return { path, label: hops.map((h) => h.field.label).join(' . '), type: last.type, reference: last.reference };
  }

  private defaultColumns(table: string, session: Session): string[] {
    const fields = [...this.meta.fields(table).values()];
    const display = this.meta.displayField(table).element;
    const out: string[] = [];
    const add = (e: string) => {
      if (!out.includes(e) && this.pathReadable(table, e, session)) out.push(e);
    };
    if (this.meta.fields(table).has('number')) add('number');
    if (display !== 'sys_id') add(display);
    for (const f of fields) {
      if (out.length >= MAX_DEFAULT_COLUMNS) break;
      if (!f.system && !LIST_SKIP_TYPES.has(f.type)) add(f.element);
    }
    add('sys_updated_on');
    return out;
  }

  private defaultFormElements(table: string): string[] {
    const fields = [...this.meta.fields(table).values()].filter((f) => !f.system);
    // Journal fields go last (they render as an input above the activity stream).
    return [...fields.filter((f) => f.type !== 'journal'), ...fields.filter((f) => f.type === 'journal')].map((f) => f.element);
  }

  /** Nearest layout row for the table (or an ancestor), preferring the requested view over "default". */
  private async findLayout(layoutTable: 'sys_ui_list' | 'sys_ui_form', table: string, view: string): Promise<RecordValues | null> {
    const views = view === DEFAULT_VIEW ? [view] : [view, DEFAULT_VIEW];
    for (const v of views) {
      for (const t of this.meta.ancestors(table)) {
        const rows = await this.engine.query(layoutTable, {
          query: {
            groups: [
              [
                [{ field: 'name', operator: '=', value: t.name }],
                [{ field: 'view', operator: '=', value: v }],
              ],
            ],
            orderBy: [],
          },
          limit: 1,
        });
        if (rows[0]) return rows[0];
      }
    }
    return null;
  }

  private relatedLists(table: string, configured: unknown, session: Session): RelatedList[] {
    let entries = parseElements(configured);
    if (!entries.length) {
      const chain = new Set(this.meta.ancestors(table).map((t) => t.name));
      for (const t of this.meta.listTables()) {
        for (const f of t.ownFields.values()) {
          if (f.active && f.type === 'reference' && f.reference && chain.has(f.reference)) entries.push(`${t.name}.${f.element}`);
        }
      }
      for (const t of chain) entries.push(...(BUILTIN_RELATED[t] ?? []));
      entries = [...new Set(entries)];
    }
    const { acl } = this.engine;
    const found: Array<{ name: string; ref: RelatedListRef }> = [];
    for (const name of entries) {
      const ref = parseRelated(name);
      if (!ref || relatedListProblem(this.meta, table, ref)) continue;
      if (!session.system) {
        if (acl.tableDecision(session, ref.table, 'read') === false) continue;
        if (acl.fieldDecision(session, ref.table, ref.field, 'read') === false) continue;
        if (ref.parentField !== 'sys_id' && acl.fieldDecision(session, table, ref.parentField, 'read') === false) continue;
      }
      found.push({ name, ref });
    }
    const perTable = new Map<string, number>();
    for (const { ref } of found) perTable.set(ref.table, (perTable.get(ref.table) ?? 0) + 1);
    return found.map(({ name, ref }) => {
      const tableLabel = this.meta.getTable(ref.table).label;
      const label = perTable.get(ref.table)! > 1 ? `${tableLabel} (${this.meta.field(ref.table, ref.field).label})` : tableLabel;
      return { name, ...ref, label };
    });
  }

  private async formAccess(table: string, sysId: string | null, fields: UiField[], session: Session): Promise<FormAccess> {
    const { acl } = this.engine;
    const editable = (f: UiField) => !f.system && !f.readOnly;
    const access: FormAccess = { canCreate: false, canWrite: false, canDelete: false, fields: {} };
    if (session.system) {
      access.canCreate = access.canWrite = access.canDelete = true;
      for (const f of fields) access.fields[f.element] = { write: editable(f) };
      return access;
    }
    access.canCreate = acl.tableDecision(session, table, 'create') !== false;
    if (sysId === null) {
      for (const f of fields) {
        // Conditional create rules are checked against the inserted row when saving.
        access.fields[f.element] = { write: access.canCreate && editable(f) && acl.fieldDecision(session, table, f.element, 'create') !== false };
      }
      return access;
    }
    access.canWrite = await this.engine.matches(table, sysId, acl.tableDecision(session, table, 'write'));
    access.canDelete = await this.engine.matches(table, sysId, acl.tableDecision(session, table, 'delete'));
    for (const f of fields) {
      const write = access.canWrite && editable(f) && (await this.engine.matches(table, sysId, acl.fieldDecision(session, table, f.element, 'write')));
      access.fields[f.element] = { write };
    }
    return access;
  }

  private async referenceLabels(pairs: ReadonlyArray<readonly [string, string | null]>, session: Session): Promise<Map<string, string>> {
    const wanted = new Map<string, Set<string>>();
    for (const [target, id] of pairs) {
      if (!id || !isUuid(id) || !this.meta.hasTable(target)) continue;
      wanted.set(target, (wanted.get(target) ?? new Set()).add(id));
    }
    const labels = new Map<string, string>();
    for (const [target, ids] of wanted) {
      if (!session.system && this.engine.acl.tableDecision(session, target, 'read') === false) continue;
      const df = this.meta.displayField(target);
      try {
        const rows = await this.engine.query(target, {
          query: { groups: [[[{ field: 'sys_id', operator: 'IN', value: [...ids].join(',') }]]], orderBy: [] },
          fields: ['sys_id', df.element],
          session,
        });
        for (const r of rows) if (r[df.element] != null) labels.set(`${target}:${String(r.sys_id)}`, String(r[df.element]));
      } catch (e) {
        if (!(e instanceof ForbiddenError)) throw e; // display field unreadable: show no label
      }
    }
    return labels;
  }
}

function normalizeView(view: string | undefined): string {
  return view && VIEW_RE.test(view) ? view : DEFAULT_VIEW;
}

function displayOf(f: FieldMeta, value: unknown): string {
  if (value == null) return '';
  if (f.type === 'choice') return f.choices.find((c) => c.value === value)?.label ?? String(value);
  if (f.type === 'json') return JSON.stringify(value);
  return String(value);
}
