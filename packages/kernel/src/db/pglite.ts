import { PGlite } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Db, QueryResult, Row } from './db';

type TxLike = Pick<PGlite, 'query' | 'exec'>;

/** Serializes top-level work so that a transaction never interleaves with other statements. */
class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

class PgliteTx implements Db {
  readonly inTransaction = true;

  constructor(private readonly tx: TxLike) {}

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.tx.query<T>(sql, params);
    return { rows: res.rows, affectedRows: res.affectedRows ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.tx.exec(sql);
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {
    throw new Error('Cannot close a transaction handle');
  }
}

/** Embedded Postgres (WASM). In-memory when no dataDir is given. */
export class PgliteDb implements Db {
  readonly inTransaction = false;
  private readonly lock = new AsyncMutex();

  private constructor(private readonly pg: PGlite) {}

  static async open(dataDir?: string): Promise<PgliteDb> {
    if (dataDir) await mkdir(path.dirname(path.resolve(dataDir)), { recursive: true }); // PGlite only creates the leaf
    const pg = dataDir ? await PGlite.create(dataDir) : await PGlite.create();
    return new PgliteDb(pg);
  }

  query<T = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.lock.run(async () => {
      const res = await this.pg.query<T>(sql, params);
      return { rows: res.rows, affectedRows: res.affectedRows ?? 0 };
    });
  }

  exec(sql: string): Promise<void> {
    return this.lock.run(async () => {
      await this.pg.exec(sql);
    });
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.lock.run(() => this.pg.transaction((tx) => fn(new PgliteTx(tx))));
  }

  close(): Promise<void> {
    return this.lock.run(() => this.pg.close());
  }
}
