import { CREATABLE_FIELD_TYPES, type FieldType } from '@steward/shared';
import { useState, type FormEvent } from 'react';
import { useApp } from '../context';
import { api, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { listUrl, navigate } from '../lib/routes';
import { ErrorBanner, Link, Spinner } from './common';

interface FieldDraft {
  key: number;
  element: string;
  label: string;
  type: FieldType;
  reference: string;
  mandatory: boolean;
  display: boolean;
  maxLength: string;
  defaultValue: string;
  choices: string;
}

let seq = 0;
const blank = (): FieldDraft => ({
  key: ++seq,
  element: '',
  label: '',
  type: 'string',
  reference: '',
  mandatory: false,
  display: false,
  maxLength: '',
  defaultValue: '',
  choices: '',
});

/** "value=Label" per line (or just "value"). */
export function parseChoices(text: string): Array<{ value: string; label: string }> {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const eq = l.indexOf('=');
      return eq === -1 ? { value: l, label: l } : { value: l.slice(0, eq).trim(), label: l.slice(eq + 1).trim() || l.slice(0, eq).trim() };
    });
}

export function fieldSpec(d: FieldDraft): Record<string, unknown> {
  const spec: Record<string, unknown> = { element: d.element.trim(), type: d.type };
  if (d.label.trim()) spec.label = d.label.trim();
  if (d.type === 'reference') spec.reference = d.reference;
  if (d.mandatory) spec.mandatory = true;
  if (d.display) spec.display = true;
  if (d.type === 'string' && d.maxLength.trim()) spec.maxLength = Number(d.maxLength);
  if (d.defaultValue.trim()) spec.defaultValue = d.defaultValue.trim();
  if (d.type === 'choice') spec.choices = parseChoices(d.choices);
  return spec;
}

/**
 * Create a table (with fields) or add fields to an existing one, through the
 * Meta API. The new table's list and form work immediately: they are generated
 * from the dictionary.
 */
export function TableBuilder({ table }: { table: string | null }) {
  const { tables, reloadNav } = useApp();
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [parent, setParent] = useState('');
  const [prefix, setPrefix] = useState('');
  const [fields, setFields] = useState<FieldDraft[]>([blank()]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const existing = useAsync(
    () => (table ? api<{ label: string; fields: Array<{ element: string; label: string; type: string }> }>(`/api/steward/meta/tables/${table}`).then((r) => r.data) : Promise.resolve(null)),
    [table],
  );

  const set = (key: number, patch: Partial<FieldDraft>) => setFields((all) => all.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  const drafts = fields.filter((f) => f.element.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (!table) {
        const body: Record<string, unknown> = { name: name.trim(), fields: drafts.map(fieldSpec) };
        if (label.trim()) body.label = label.trim();
        if (parent) body.extends = parent;
        if (prefix.trim()) body.numberPrefix = prefix.trim();
        await api('/api/steward/meta/tables', { method: 'POST', body });
        reloadNav();
        navigate(listUrl(name.trim()));
      } else {
        const done: string[] = [];
        for (const d of drafts) {
          try {
            await api(`/api/steward/meta/tables/${table}/fields`, { method: 'POST', body: fieldSpec(d) });
            done.push(d.element);
            setFields((all) => all.filter((x) => x.key !== d.key));
          } catch (err) {
            if (done.length) existing.reload();
            throw new Error(`${done.length ? `Added ${done.join(', ')}; ` : ''}${d.element}: ${errorMessage(err)}`);
          }
        }
        navigate(listUrl(table));
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (table && existing.error) return <ErrorBanner error={existing.error} />;
  if (table && !existing.data) return <Spinner />;

  return (
    <section className="table-builder" aria-label="Table builder">
      <form onSubmit={submit}>
        <div className="toolbar">
          <h2>{table ? `Add fields to ${existing.data?.label ?? table}` : 'Create table'}</h2>
          <span className="spacer" />
          {table && <Link href={listUrl(table)}>Open list</Link>}
          <button type="submit" className="primary" disabled={busy || (!table && !name.trim()) || (!!table && !drafts.length)}>
            {table ? 'Add fields' : 'Create'}
          </button>
        </div>
        <ErrorBanner error={error} />
        {!table && (
          <div className="form-grid">
            <div className="form-field">
              <label htmlFor="tb_name">Name</label>
              <input id="tb_name" placeholder="u_vehicle" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
            </div>
            <div className="form-field">
              <label htmlFor="tb_label">Label</label>
              <input id="tb_label" placeholder="Vehicle" value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div className="form-field">
              <label htmlFor="tb_extends">Extends</label>
              <select id="tb_extends" value={parent} onChange={(e) => setParent(e.target.value)}>
                <option value="">-- None --</option>
                {tables.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.label} ({t.name})
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="tb_prefix">Number prefix</label>
              <input id="tb_prefix" placeholder="VEH" value={prefix} onChange={(e) => setPrefix(e.target.value.toUpperCase())} />
            </div>
          </div>
        )}
        {table && existing.data && (
          <p className="muted small">
            Existing fields:{' '}
            {existing.data.fields
              .filter((f) => !f.element.startsWith('sys_'))
              .map((f) => `${f.label} (${f.type})`)
              .join(', ') || 'none'}
          </p>
        )}
        <h3>Fields</h3>
        <table className="grid field-grid">
          <thead>
            <tr>
              <th>Column name</th>
              <th>Label</th>
              <th>Type</th>
              <th>Reference / choices / max length</th>
              <th>Default</th>
              <th>Mandatory</th>
              <th>Display</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {fields.map((f, i) => (
              <tr key={f.key} data-testid="field-row">
                <td>
                  <input aria-label={`Field ${i + 1} column name`} value={f.element} onChange={(e) => set(f.key, { element: e.target.value.toLowerCase() })} />
                </td>
                <td>
                  <input aria-label={`Field ${i + 1} label`} value={f.label} onChange={(e) => set(f.key, { label: e.target.value })} />
                </td>
                <td>
                  <select aria-label={`Field ${i + 1} type`} value={f.type} onChange={(e) => set(f.key, { type: e.target.value as FieldType })}>
                    {CREATABLE_FIELD_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {f.type === 'reference' && (
                    <select aria-label={`Field ${i + 1} reference`} value={f.reference} onChange={(e) => set(f.key, { reference: e.target.value })}>
                      <option value="">-- table --</option>
                      {tables.map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.label} ({t.name})
                        </option>
                      ))}
                    </select>
                  )}
                  {f.type === 'choice' && (
                    <textarea aria-label={`Field ${i + 1} choices`} rows={3} placeholder={'1=High\n2=Medium\n3=Low'} value={f.choices} onChange={(e) => set(f.key, { choices: e.target.value })} />
                  )}
                  {f.type === 'string' && (
                    <input aria-label={`Field ${i + 1} max length`} type="number" min={1} placeholder="40" value={f.maxLength} onChange={(e) => set(f.key, { maxLength: e.target.value })} />
                  )}
                </td>
                <td>
                  <input aria-label={`Field ${i + 1} default`} value={f.defaultValue} onChange={(e) => set(f.key, { defaultValue: e.target.value })} />
                </td>
                <td>
                  <input type="checkbox" aria-label={`Field ${i + 1} mandatory`} checked={f.mandatory} onChange={(e) => set(f.key, { mandatory: e.target.checked })} />
                </td>
                <td>
                  <input type="checkbox" aria-label={`Field ${i + 1} display`} checked={f.display} onChange={(e) => set(f.key, { display: e.target.checked })} />
                </td>
                <td>
                  <button type="button" className="link danger" aria-label={`Remove field ${i + 1}`} onClick={() => setFields((all) => all.filter((x) => x.key !== f.key))}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" onClick={() => setFields((all) => [...all, blank()])}>
          Add field
        </button>
      </form>
    </section>
  );
}
