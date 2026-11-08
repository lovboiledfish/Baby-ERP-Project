export type Row = Record<string, unknown>;

export interface QueryResult<T = Row> {
  rows: T[];
  affectedRows: number;
}

/**
 * Minimal database port used by the kernel. Implemented by PGlite today;
 * a node-postgres adapter can implement the same interface later.
 */
export interface Db {
  readonly inTransaction: boolean;
  query<T = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Execute one or more statements without parameters (used for DDL). */
  exec(sql: string): Promise<void>;
  /** Run fn in a transaction. Nested calls join the outer transaction. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
