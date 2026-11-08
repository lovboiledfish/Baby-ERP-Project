import { randomUUID } from 'node:crypto';
import { quoteIdent } from '../util';
import type { Db } from './db';

/** Plain INSERT without hooks, audit or validation. For bootstrap and platform-internal tables only. */
export async function rawInsert(db: Db, physical: string, values: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(values);
  const sql =
    `INSERT INTO ${quoteIdent(physical)} (${cols.map(quoteIdent).join(', ')}) ` +
    `VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`;
  await db.query(sql, cols.map((c) => values[c]));
}

export function systemValues(table: string, userName: string, sysId: string = randomUUID()): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    sys_id: sysId,
    sys_class_name: table,
    sys_created_on: now,
    sys_created_by: userName,
    sys_updated_on: now,
    sys_updated_by: userName,
    sys_mod_count: 0,
  };
}
