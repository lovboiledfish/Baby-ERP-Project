const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Quote a generated SQL identifier. Only lowercase snake_case is ever allowed. */
export function quoteIdent(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`Unsafe SQL identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/** Quote an arbitrary column alias such as "caller.department.name". */
export function quoteAlias(alias: string): string {
  return `"${alias.replaceAll('"', '""')}"`;
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function titleize(name: string): string {
  return name
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Short stable hash, used to keep generated index names under Postgres' 63 char limit. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
