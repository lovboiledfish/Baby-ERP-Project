import { stringifyEncodedQuery } from '@steward/shared';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { formUrl } from '../lib/routes';
import { Link } from './common';

interface Props {
  table: string;
  displayField: string;
  value: string | null;
  display: string;
  onChange: (value: string | null, display: string) => void;
  disabled?: boolean;
  id?: string;
  label: string;
}

const LIMIT = 10;

/** Reference field input with type-ahead lookup against the referenced table (ACLs apply). */
export function ReferencePicker({ table, displayField, value, display, onChange, disabled, id, label }: Props) {
  const [text, setText] = useState(display);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Array<{ sys_id: string; label: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => setText(display), [display, value]);

  const search = (q: string) => {
    const mine = ++seq.current;
    const query = stringifyEncodedQuery({
      groups: q.trim() ? [[[{ field: displayField, operator: 'LIKE', value: q.trim() }]]] : [],
      orderBy: [{ field: displayField, desc: false }],
    });
    api<Array<Record<string, unknown>>>(`/api/now/table/${table}`, {
      query: { sysparm_query: query, sysparm_fields: `sys_id,${displayField}`, sysparm_limit: LIMIT },
    }).then(
      ({ data }) => {
        if (mine !== seq.current) return;
        setError(null);
        setOptions(data.map((r) => ({ sys_id: String(r.sys_id), label: r[displayField] == null ? String(r.sys_id) : String(r[displayField]) })));
        setOpen(true);
      },
      (e: unknown) => {
        if (mine !== seq.current) return;
        setOptions([]);
        setError(errorMessage(e));
        setOpen(true);
      },
    );
  };

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => search(text), 200);
    return () => clearTimeout(t);
    // Re-search when the text changes while the dropdown is open.
  }, [text, open]);

  const choose = (opt: { sys_id: string; label: string } | null) => {
    setOpen(false);
    seq.current++;
    if (opt) {
      setText(opt.label);
      onChange(opt.sys_id, opt.label);
    } else {
      setText('');
      onChange(null, '');
    }
  };

  return (
    <div className="ref-picker">
      <input
        id={id}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        value={text}
        disabled={disabled}
        placeholder={disabled ? '' : `Search ${table}`}
        onFocus={() => !disabled && setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          if (e.target.value === '' && value !== null) onChange(null, '');
        }}
        onBlur={() => {
          setOpen(false);
          setText(display);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            setText(display);
          }
        }}
      />
      {value && (
        <Link className="ref-open" href={formUrl(table, value)} title="Open referenced record" aria-label={`Open ${label}`}>
          ↗
        </Link>
      )}
      {open && !disabled && (
        <ul className="ref-options" role="listbox" aria-label={`${label} options`}>
          {error && <li className="error">{error}</li>}
          {!error && options.length === 0 && <li className="muted">No matches</li>}
          {options.map((o) => (
            <li
              key={o.sys_id}
              role="option"
              aria-selected={o.sys_id === value}
              onMouseDown={(e) => (e.preventDefault(), choose(o))}
              onClick={() => choose(o)}
            >
              {o.label}
            </li>
          ))}
          {value && (
            <li
              className="muted"
              role="option"
              aria-selected={false}
              onMouseDown={(e) => (e.preventDefault(), choose(null))}
              onClick={() => choose(null)}
            >
              — Clear —
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
