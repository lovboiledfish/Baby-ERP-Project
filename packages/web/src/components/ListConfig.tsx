import type { ListLayout } from '@steward/kernel';
import { useState } from 'react';
import { api } from '../lib/api';
import { ErrorBanner } from './common';

/** Admin dialog: choose and order list columns; saved as a sys_ui_list record for this table and view. */
export function ListConfig({ layout, onClose }: { layout: ListLayout; onClose: (saved: boolean) => void }) {
  const [selected, setSelected] = useState<string[]>(layout.columns.map((c) => c.path));
  const [error, setError] = useState<unknown>(null);
  const own = layout.layoutId !== null && layout.layoutTable === layout.table.name && layout.layoutView === layout.view;
  const labelOf = (path: string) => layout.columns.find((c) => c.path === path)?.label ?? layout.fields.find((f) => f.element === path)?.label ?? path;
  const available = layout.fields.filter((f) => f.type !== 'password' && f.type !== 'journal' && !selected.includes(f.element));

  const move = (i: number, d: number) =>
    setSelected((s) => {
      const next = [...s];
      const j = i + d;
      if (j < 0 || j >= next.length) return s;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const save = async () => {
    setError(null);
    try {
      const elements = selected.join(',');
      if (own) await api(`/api/now/table/sys_ui_list/${layout.layoutId}`, { method: 'PATCH', body: { elements } });
      else await api('/api/now/table/sys_ui_list', { method: 'POST', body: { name: layout.table.name, view: layout.view, elements } });
      onClose(true);
    } catch (e) {
      setError(e);
    }
  };

  const reset = async () => {
    setError(null);
    try {
      await api(`/api/now/table/sys_ui_list/${layout.layoutId}`, { method: 'DELETE' });
      onClose(true);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="dialog" role="dialog" aria-label="Configure list columns">
      <h3>
        Columns of {layout.table.label} ({layout.view})
      </h3>
      <ErrorBanner error={error} />
      <div className="dialog-columns">
        <div>
          <h4>Available</h4>
          <ul className="pick-list">
            {available.map((f) => (
              <li key={f.element}>
                <button type="button" className="link" onClick={() => setSelected((s) => [...s, f.element])}>
                  + {f.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4>Selected</h4>
          <ol className="pick-list">
            {selected.map((p, i) => (
              <li key={p}>
                <span>{labelOf(p)}</span>
                <button type="button" className="link" aria-label={`Move ${labelOf(p)} up`} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button type="button" className="link" aria-label={`Move ${labelOf(p)} down`} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button type="button" className="link danger" aria-label={`Remove ${labelOf(p)}`} onClick={() => setSelected((s) => s.filter((x) => x !== p))}>
                  ✕
                </button>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <div className="dialog-actions">
        <button type="button" className="primary" disabled={!selected.length} onClick={save}>
          Save
        </button>
        {own && (
          <button type="button" onClick={reset}>
            Reset to inherited/default
          </button>
        )}
        <button type="button" onClick={() => onClose(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
