import type { HookRegistry, SystemHook } from '../data/hooks';
import { ValidationError } from '../errors';
import type { MetaService } from '../meta/meta-service';
import { parseElements, parseRelated, relatedListProblem, resolvePath, VIEW_RE } from './layout';

function checkTable(meta: MetaService, what: string, name: unknown): string {
  const table = String(name ?? '').trim();
  if (!meta.hasTable(table)) throw new ValidationError(`${what}: table "${table}" does not exist`);
  return table;
}

function checkView(what: string, current: Record<string, unknown>): void {
  const view = String(current.view ?? 'default').trim();
  if (!VIEW_RE.test(view)) throw new ValidationError(`${what}: invalid view "${view}"`, 'Use lowercase letters, digits and _');
  current.view = view;
}

/** Validate + normalize an element list; returns the canonical comma-separated form. */
function checkElements(meta: MetaService, what: string, table: string, raw: unknown, required: boolean): string | null {
  const elements = parseElements(raw);
  if (!elements.length) {
    if (required) throw new ValidationError(`${what}: at least one field is required`);
    return null;
  }
  const bad = elements.filter((e) => !resolvePath(meta, table, e));
  if (bad.length) throw new ValidationError(`${what}: unknown fields on ${table}: ${bad.join(', ')}`);
  return elements.join(',');
}

/** Validation for the UI layout tables, so the renderer can trust what it reads. */
export function uiHooks(): SystemHook[] {
  return [
    {
      name: 'sys_ui_list: validate',
      table: 'sys_ui_list',
      when: 'before',
      operations: ['insert', 'update'],
      run({ engine, current }) {
        const table = checkTable(engine.meta, 'List layout', current.name);
        current.name = table;
        checkView('List layout', current);
        current.elements = checkElements(engine.meta, 'List layout', table, current.elements, true);
      },
    },
    {
      name: 'sys_ui_form: validate',
      table: 'sys_ui_form',
      when: 'before',
      operations: ['insert', 'update'],
      run({ engine, current }) {
        const table = checkTable(engine.meta, 'Form layout', current.name);
        current.name = table;
        checkView('Form layout', current);
        const entries = parseElements(current.related_lists);
        for (const entry of entries) {
          const ref = parseRelated(entry);
          const problem = ref ? relatedListProblem(engine.meta, table, ref) : 'use table.field or table.field=parent_field';
          if (problem) throw new ValidationError(`Form layout: invalid related list "${entry}"`, problem);
        }
        current.related_lists = entries.length ? entries.join(',') : null;
      },
    },
    {
      name: 'sys_ui_section: validate',
      table: 'sys_ui_section',
      when: 'before',
      operations: ['insert', 'update'],
      async run({ engine, current }) {
        const res = await engine.db.query<{ name: string }>(`SELECT "name" FROM "sys_ui_form" WHERE "sys_id" = $1`, [current.form]);
        const form = res.rows[0];
        if (!form) throw new ValidationError('Form section: form layout does not exist');
        const table = checkTable(engine.meta, 'Form section', form.name);
        current.elements = checkElements(engine.meta, 'Form section', table, current.elements, false);
      },
    },
  ];
}

export function registerUiHooks(registry: HookRegistry): void {
  registry.register(...uiHooks());
}
