import type { FormLayout } from '@steward/kernel';
import { useState } from 'react';
import { api } from '../lib/api';
import { ErrorBanner } from './common';

interface SectionDraft {
  caption: string;
  elements: string;
}

/**
 * Admin dialog: edit the form layout of this table and view. Saved as one
 * sys_ui_form record plus its sys_ui_section records (sections are replaced).
 */
export function FormConfig({ form, onClose }: { form: FormLayout; onClose: (saved: boolean) => void }) {
  const own = form.layoutId !== null && form.layoutTable === form.table.name && form.layoutView === form.view;
  const [sections, setSections] = useState<SectionDraft[]>(form.sections.map((s) => ({ caption: s.caption, elements: s.elements.join(', ') })));
  const [related, setRelated] = useState(form.relatedListConfig.join(', '));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      let formId = own ? form.layoutId! : null;
      if (formId) {
        await api(`/api/now/table/sys_ui_form/${formId}`, { method: 'PATCH', body: { related_lists: related } });
      } else {
        const { data } = await api<{ sys_id: string }>('/api/now/table/sys_ui_form', {
          method: 'POST',
          body: { name: form.table.name, view: form.view, related_lists: related },
        });
        formId = data.sys_id;
      }
      const { data: existing } = await api<Array<{ sys_id: string }>>('/api/now/table/sys_ui_section', {
        query: { sysparm_query: `form=${formId}`, sysparm_fields: 'sys_id', sysparm_limit: 1000 },
      });
      const created: string[] = [];
      try {
        for (const [i, s] of sections.entries()) {
          const { data } = await api<{ sys_id: string }>('/api/now/table/sys_ui_section', {
            method: 'POST',
            body: { form: formId, caption: s.caption, position: (i + 1) * 100, elements: s.elements },
          });
          created.push(data.sys_id);
        }
      } catch (err) {
        for (const id of created) await api(`/api/now/table/sys_ui_section/${id}`, { method: 'DELETE' }).catch(() => undefined);
        if (!own) await api(`/api/now/table/sys_ui_form/${formId}`, { method: 'DELETE' }).catch(() => undefined);
        throw err;
      }
      for (const s of existing) await api(`/api/now/table/sys_ui_section/${s.sys_id}`, { method: 'DELETE' });
      onClose(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const set = (i: number, patch: Partial<SectionDraft>) => setSections((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <div className="dialog" role="dialog" aria-label="Configure form">
      <h3>
        Form layout of {form.table.label} ({form.view})
      </h3>
      <p className="muted small">Fields: {form.fields.filter((f) => !f.system).map((f) => f.element).join(', ')}</p>
      <ErrorBanner error={error} />
      {sections.map((s, i) => (
        <div key={i} className="section-draft">
          <label>
            Section caption
            <input value={s.caption} onChange={(e) => set(i, { caption: e.target.value })} />
          </label>
          <label>
            Fields (comma separated)
            <textarea rows={2} value={s.elements} onChange={(e) => set(i, { elements: e.target.value })} />
          </label>
          <button type="button" className="link danger" onClick={() => setSections((all) => all.filter((_, j) => j !== i))}>
            Remove section
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setSections((all) => [...all, { caption: '', elements: '' }])}>
        Add section
      </button>
      <label>
        Related lists (table.field or table.field=parent_field, comma separated; empty = automatic)
        <textarea rows={2} value={related} onChange={(e) => setRelated(e.target.value)} />
      </label>
      <div className="dialog-actions">
        <button type="button" className="primary" disabled={busy} onClick={save}>
          Save
        </button>
        <button type="button" onClick={() => onClose(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
