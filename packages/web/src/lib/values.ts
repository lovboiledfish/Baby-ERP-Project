import type { FieldType } from '@steward/shared';

/** Form-level value for an input. Booleans stay booleans; everything else is a string. */
export type InputValue = string | boolean;

const pad = (n: number) => String(n).padStart(2, '0');

/** Convert a stored value into what an <input> of that field type expects. */
export function toInputValue(type: FieldType, value: unknown): InputValue {
  if (type === 'boolean') return value === true || value === 'true';
  if (value === null || value === undefined) return '';
  if (type === 'datetime') {
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  if (type === 'json') return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return String(value);
}

export class InputError extends Error {}

/** Convert an input value back into what the Table API accepts. Empty -> null. */
export function fromInputValue(type: FieldType, input: InputValue, label = 'Value'): unknown {
  if (type === 'boolean') return input === true;
  const s = typeof input === 'string' ? input : String(input);
  if (s.trim() === '' && type !== 'string' && type !== 'text' && type !== 'journal' && type !== 'script') return null;
  if (s === '') return null;
  switch (type) {
    case 'integer':
    case 'decimal': {
      const n = Number(s);
      if (!Number.isFinite(n) || (type === 'integer' && !Number.isInteger(n))) throw new InputError(`${label} must be ${type === 'integer' ? 'a whole number' : 'a number'}`);
      return n;
    }
    case 'datetime': {
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) throw new InputError(`${label} must be a date and time`);
      return d.toISOString();
    }
    case 'json':
      try {
        return JSON.parse(s);
      } catch {
        throw new InputError(`${label} must be valid JSON`);
      }
    default:
      return s;
  }
}

export function isEmptyInput(input: InputValue | undefined): boolean {
  return input === undefined || (typeof input === 'string' && input.trim() === '');
}
