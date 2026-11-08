import { ValidationError } from '../errors';
import type { FieldMeta } from '../meta/types';
import { isUuid } from '../util';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

const where = (f: FieldMeta) => `${f.table}.${f.element}`;

/** Convert an incoming value to the canonical JS representation for a field. Empty -> null. */
export function coerceValue(field: FieldMeta, raw: unknown): unknown {
  if (raw === undefined || raw === null) return null;
  if (raw === '' && field.type !== 'json') return null;

  switch (field.type) {
    case 'string':
    case 'text':
    case 'script':
    case 'choice':
    case 'sys_class_name': {
      if (typeof raw === 'object') throw new ValidationError(`${where(field)} must be a string`);
      const s = String(raw);
      if (field.type === 'string' && field.maxLength != null && s.length > field.maxLength) {
        throw new ValidationError(`${where(field)} exceeds max length ${field.maxLength}`);
      }
      if (field.type === 'choice' && field.choices.length > 0 && !field.choices.some((c) => c.value === s)) {
        throw new ValidationError(
          `Invalid choice "${s}" for ${where(field)}`,
          `Allowed: ${field.choices.map((c) => c.value).join(', ')}`,
        );
      }
      return s;
    }
    case 'integer': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isInteger(n) || n < INT32_MIN || n > INT32_MAX) {
        throw new ValidationError(`${where(field)} must be an integer`);
      }
      return n;
    }
    case 'decimal': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) throw new ValidationError(`${where(field)} must be a number`);
      return n;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === '1' || raw === 1) return true;
      if (raw === 'false' || raw === '0' || raw === 0) return false;
      throw new ValidationError(`${where(field)} must be a boolean`);
    }
    case 'date': {
      const s = String(raw);
      const d = new Date(`${s}T00:00:00Z`);
      if (!DATE_RE.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
        throw new ValidationError(`${where(field)} must be a date (YYYY-MM-DD)`);
      }
      return s;
    }
    case 'datetime': {
      const d = raw instanceof Date ? raw : new Date(String(raw));
      if (Number.isNaN(d.getTime())) throw new ValidationError(`${where(field)} must be an ISO date-time`);
      return d.toISOString();
    }
    case 'reference':
    case 'guid': {
      const s = String(raw).toLowerCase();
      if (!isUuid(s)) throw new ValidationError(`${where(field)} must be a sys_id (uuid)`);
      return s;
    }
    case 'json':
      return raw;
  }
}

/** Convert a canonical value into a Postgres parameter. */
export function toDbParam(field: FieldMeta, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (field.type === 'json') return JSON.stringify(value);
  return value;
}

export function sameValue(field: FieldMeta, a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (field.type === 'json') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

/** String form used in sys_audit. */
export function toAuditString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
