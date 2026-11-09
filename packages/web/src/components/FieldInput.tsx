import type { UiField } from '@steward/kernel';
import type { InputValue } from '../lib/values';
import { ReferencePicker } from './ReferencePicker';

interface Props {
  field: UiField;
  value: InputValue;
  /** Display value (reference fields). */
  display: string;
  readOnly: boolean;
  isNew: boolean;
  onChange: (value: InputValue, display?: string) => void;
}

/** One form widget, chosen by dictionary type. */
export function FieldInput({ field, value, display, readOnly, isNew, onChange }: Props) {
  const id = `f_${field.element}`;
  const str = typeof value === 'string' ? value : '';
  const common = { id, name: field.element, disabled: readOnly, 'aria-label': field.label };

  switch (field.type) {
    case 'boolean':
      return <input type="checkbox" {...common} checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case 'choice':
      return (
        <select {...common} value={str} onChange={(e) => onChange(e.target.value)}>
          <option value="">-- None --</option>
          {field.choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
          {str && !field.choices.some((c) => c.value === str) && <option value={str}>{str}</option>}
        </select>
      );
    case 'reference':
      return field.reference ? (
        <ReferencePicker
          id={id}
          label={field.label}
          table={field.reference}
          displayField={field.referenceDisplayField ?? 'sys_id'}
          value={str || null}
          display={display}
          disabled={readOnly}
          onChange={(v, d) => onChange(v ?? '', d)}
        />
      ) : (
        <input {...common} value={str} readOnly />
      );
    case 'integer':
      return <input type="number" step="1" {...common} value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'decimal':
      return <input type="number" step="any" {...common} value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'date':
      return <input type="date" {...common} value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'datetime':
      return <input type="datetime-local" step="1" {...common} value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'text':
    case 'script':
    case 'json':
      return <textarea {...common} rows={field.type === 'text' ? 3 : 6} className={field.type === 'text' ? '' : 'mono'} value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'journal':
      return <textarea {...common} rows={3} placeholder={readOnly ? '' : `Add ${field.label.toLowerCase()}`} value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'password':
      return (
        <input
          type="password"
          autoComplete="new-password"
          {...common}
          placeholder={isNew ? '' : readOnly ? '' : '(unchanged)'}
          value={str}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return <input type="text" {...common} maxLength={field.type === 'string' && field.maxLength ? field.maxLength : undefined} value={str} onChange={(e) => onChange(e.target.value)} />;
  }
}
