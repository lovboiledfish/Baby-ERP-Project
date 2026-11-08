import type { Db } from '../db/db';
import { rawInsert, systemValues } from '../db/raw';

export interface AuditEntry {
  table: string;
  documentKey: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  checkpoint: number;
  reason?: string;
}

export async function writeAudit(db: Db, userName: string, entries: AuditEntry[]): Promise<void> {
  for (const e of entries) {
    await rawInsert(db, 'sys_audit', {
      ...systemValues('sys_audit', userName),
      tablename: e.table,
      documentkey: e.documentKey,
      fieldname: e.field,
      oldvalue: e.oldValue,
      newvalue: e.newValue,
      user: userName,
      record_checkpoint: e.checkpoint,
      reason: e.reason ?? null,
    });
  }
}
