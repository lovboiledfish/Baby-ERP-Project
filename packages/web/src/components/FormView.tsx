import type { FormLayout, UiField } from '@steward/kernel';
import { useEffect, useState, type FormEvent } from 'react';
import { useApp } from '../context';
import { api } from '../lib/api';
import { prefillFromQuery } from '../lib/conditions';
import { useAsync } from '../lib/hooks';
import { formUrl, listUrl, navigate, tableBuilderUrl } from '../lib/routes';
import { fromInputValue, InputError, isEmptyInput, toInputValue, type InputValue } from '../lib/values';
import { Activity } from './Activity';
import { ErrorBanner, Link, Spinner } from './common';
import { FieldInput } from './FieldInput';
import { FormConfig } from './FormConfig';
import { RelatedLists } from './RelatedLists';

interface Props {
  table: string;
  sysId: string;
  /** Encoded query of `field=value` pairs prefilled into a new record. */
  query: string;
  view: string;
}

type Values = Record<string, InputValue>;

/** A form generated from sys_ui_form / sys_ui_section (or the dictionary), honouring field-level ACL decisions. */
export function FormView({ table, sysId, query, view }: Props) {
  const { isAdmin, reloadNav } = useApp();
  const form = useAsync(
    () => api<FormLayout>(`/api/steward/ui/form/${table}`, { query: { sys_id: sysId, sysparm_view: view } }).then((r) => r.data),
    [table, sysId, view],
  );
  const [values, setValues] = useState<Values>({});
  const [initial, setInitial] = useState<Values>({});
  const [displays, setDisplays] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activityKey, setActivityKey] = useState(0);
  const [configuring, setConfiguring] = useState(false);

  const f = form.data;

  useEffect(() => {
    if (f?.recordClass) navigate(formUrl(f.recordClass, sysId, { view }), { replace: true });
  }, [f, sysId, view]);

  useEffect(() => {
    if (!f) return;
    const v: Values = {};
    const d: Record<string, string> = {};
    for (const field of f.fields) {
      const cell = f.record[field.element];
      v[field.element] = field.type === 'password' || field.type === 'journal' ? '' : toInputValue(field.type, cell?.value ?? null);
      d[field.element] = cell?.display_value ?? '';
    }
    const pendingRefs: UiField[] = [];
    if (f.isNew) {
      for (const [k, raw] of Object.entries(prefillFromQuery(query))) {
        const field = f.fields.find((x) => x.element === k);
        if (!field || field.system) continue;
        v[k] = toInputValue(field.type, raw);
        d[k] = raw;
        if (field.type === 'reference') pendingRefs.push(field);
      }
    }
    setValues(v);
    setInitial(v);
    setDisplays(d);
    setError(null);
    // Resolve display values of prefilled references.
    for (const field of pendingRefs) {
      const id = v[field.element];
      if (!field.reference || !field.referenceDisplayField || typeof id !== 'string') continue;
      api<Record<string, unknown>>(`/api/now/table/${field.reference}/${id}`, { query: { sysparm_fields: field.referenceDisplayField } }).then(
        ({ data }) => setDisplays((m) => ({ ...m, [field.element]: String(data[field.referenceDisplayField!] ?? id) })),
        () => undefined,
      );
    }
  }, [f, query]);

  if (form.error) return <ErrorBanner error={form.error} />;
  if (!f || f.recordClass) return <Spinner />;

  const byName = new Map(f.fields.map((x) => [x.element, x]));
  const canEdit = (field: UiField) => (f.isNew ? f.access.canCreate : f.access.canWrite) && f.access.fields[field.element]?.write === true;
  const title = f.isNew ? `New ${f.table.label}` : f.record[f.table.displayField]?.display_value || f.table.label;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    const body: Record<string, unknown> = {};
    const problems: string[] = [];
    for (const field of f.fields) {
      if (!canEdit(field)) continue;
      const input = values[field.element];
      const writeOnly = field.type === 'password' || field.type === 'journal';
      if (field.mandatory && isEmptyInput(input) && (f.isNew || !writeOnly)) {
        problems.push(`${field.label} is mandatory`);
        continue;
      }
      const changed = f.isNew ? !isEmptyInput(input) || field.type === 'boolean' : writeOnly ? !isEmptyInput(input) : input !== initial[field.element];
      if (!changed) continue;
      try {
        body[field.element] = fromInputValue(field.type, input ?? '', field.label);
      } catch (err) {
        if (err instanceof InputError) problems.push(err.message);
        else throw err;
      }
    }
    if (problems.length) {
      setError(new Error(problems.join('; ')));
      return;
    }
    setBusy(true);
    try {
      if (f.isNew) {
        const { data } = await api<Record<string, unknown>>(`/api/now/table/${table}`, { method: 'POST', body });
        if (table === 'sys_db_object') reloadNav();
        navigate(formUrl(table, String(data.sys_id), { view }), { replace: true });
      } else {
        if (!Object.keys(body).length) {
          setMessage('No changes to save');
          return;
        }
        const modCount = f.record.sys_mod_count?.value;
        await api(`/api/now/table/${table}/${sysId}`, {
          method: 'PATCH',
          body,
          headers: typeof modCount === 'number' ? { 'If-Match': `"${modCount}"` } : {},
        });
        setMessage('Record updated');
        setActivityKey((k) => k + 1);
        form.reload();
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete this ${f.table.label} record?`)) return;
    setError(null);
    try {
      await api(`/api/now/table/${table}/${sysId}`, { method: 'DELETE' });
      navigate(listUrl(table, { view }));
    } catch (err) {
      setError(err);
    }
  };

  return (
    <section className="form" aria-label={`${f.table.label} form`}>
      <form onSubmit={save} noValidate>
        <div className="toolbar">
          <Link href={listUrl(table, { view })} aria-label="Back to list">
            ‹ {f.table.label}
          </Link>
          <h2 data-testid="form-title">{title}</h2>
          <span className="spacer" />
          {table === 'sys_db_object' && !f.isNew && typeof f.record.name?.value === 'string' && (
            <>
              <Link className="button" href={tableBuilderUrl(f.record.name.value)}>
                Add fields
              </Link>
              <Link className="button" href={listUrl(f.record.name.value)}>
                Open list
              </Link>
            </>
          )}
          {isAdmin && (
            <button type="button" onClick={() => setConfiguring(true)}>
              Configure form
            </button>
          )}
          {!f.isNew && f.access.canDelete && (
            <button type="button" className="danger" onClick={remove}>
              Delete
            </button>
          )}
          {(f.isNew ? f.access.canCreate : f.access.canWrite) && (
            <button type="submit" className="primary" disabled={busy}>
              {f.isNew ? 'Submit' : 'Update'}
            </button>
          )}
        </div>
        {message && (
          <div className="banner banner-info" role="status">
            {message}
          </div>
        )}
        <ErrorBanner error={error} />
        {!f.isNew && !f.access.canWrite && <div className="muted small">Read only: you are not allowed to change this record.</div>}
        {f.sections.map((section, si) => (
          <fieldset key={si} className="form-section">
            {section.caption && <legend>{section.caption}</legend>}
            <div className="form-grid">
              {section.elements.map((el) => {
                const field = byName.get(el);
                if (!field) return null;
                const readOnly = !canEdit(field);
                return (
                  <div key={el} className={`form-field type-${field.type}`}>
                    <label htmlFor={`f_${el}`}>
                      {field.mandatory && !readOnly && <span className="mandatory" title="Mandatory">*</span>}
                      {field.label}
                    </label>
                    <FieldInput
                      field={field}
                      value={values[el] ?? ''}
                      display={displays[el] ?? ''}
                      readOnly={readOnly}
                      isNew={f.isNew}
                      onChange={(value, display) => {
                        setValues((m) => ({ ...m, [el]: value }));
                        if (display !== undefined) setDisplays((m) => ({ ...m, [el]: display }));
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}
      </form>
      {configuring && <FormConfig form={f} onClose={(saved) => (setConfiguring(false), saved && form.reload())} />}
      {!f.isNew && <RelatedLists form={f} sysId={sysId} />}
      {!f.isNew && <Activity table={table} sysId={sysId} reloadKey={activityKey} />}
    </section>
  );
}
