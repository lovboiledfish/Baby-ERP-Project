import { bootstrap, isBootstrapped } from './bootstrap/system-tables';
import { DataEngine } from './data/data-engine';
import { GlideRecord } from './data/glide-record';
import { HookRegistry } from './data/hooks';
import type { Db } from './db/db';
import { PgliteDb } from './db/pglite';
import { MetaApi } from './meta/meta-api';
import { registerMetadataHooks } from './meta/meta-hooks';
import { MetaService } from './meta/meta-service';
import { SYSTEM_SESSION, type Session } from './session';

export interface InstanceOptions {
  /** PGlite data directory. Omit for an in-memory instance. */
  dataDir?: string;
  /** Bring your own database (overrides dataDir). */
  db?: Db;
}

/** One Steward instance = one database + its kernel services. */
export class Instance {
  private constructor(
    readonly db: Db,
    readonly meta: MetaService,
    readonly hooks: HookRegistry,
    readonly engine: DataEngine,
    readonly metaApi: MetaApi,
  ) {}

  static async create(opts: InstanceOptions = {}): Promise<Instance> {
    const db = opts.db ?? (await PgliteDb.open(opts.dataDir));
    if (!(await isBootstrapped(db))) await bootstrap(db);

    const meta = new MetaService();
    await meta.load(db);
    const hooks = new HookRegistry();
    registerMetadataHooks(hooks);
    const engine = new DataEngine(db, meta, hooks);
    return new Instance(db, meta, hooks, engine, new MetaApi(engine));
  }

  glideRecord(table: string, session: Session = SYSTEM_SESSION): GlideRecord {
    return new GlideRecord(this.engine, table, session);
  }

  close(): Promise<void> {
    return this.db.close();
  }
}
