import { randomBytes } from 'node:crypto';
import { bootstrap } from './bootstrap/system-tables';
import { DataEngine } from './data/data-engine';
import { GlideRecord } from './data/glide-record';
import { HookRegistry } from './data/hooks';
import type { Db } from './db/db';
import { PgliteDb } from './db/pglite';
import { MetaApi } from './meta/meta-api';
import { registerMetadataHooks } from './meta/meta-hooks';
import { MetaService } from './meta/meta-service';
import { AclService } from './security/acl-service';
import { AuthService, type AuthOptions } from './security/auth-service';
import { hashPassword } from './security/password';
import { registerSecurityHooks } from './security/security-hooks';
import { SYSTEM_SESSION, type Session } from './session';

export interface InstanceOptions extends AuthOptions {
  /** PGlite data directory. Omit for an in-memory instance. */
  dataDir?: string;
  /** Bring your own database (overrides dataDir). */
  db?: Db;
  /**
   * Password for the built-in admin user, applied only while admin has no password
   * (fresh instance, or one created before Phase 2). If omitted in that case, a
   * random password is generated and exposed as `generatedAdminPassword`.
   */
  adminPassword?: string;
}

/** One Steward instance = one database + its kernel services. */
export class Instance {
  /** Set when this boot generated the admin password (show it to the operator once). */
  generatedAdminPassword: string | null = null;

  private constructor(
    readonly db: Db,
    readonly meta: MetaService,
    readonly hooks: HookRegistry,
    readonly acl: AclService,
    readonly engine: DataEngine,
    readonly metaApi: MetaApi,
    readonly auth: AuthService,
  ) {}

  static async create(opts: InstanceOptions = {}): Promise<Instance> {
    const db = opts.db ?? (await PgliteDb.open(opts.dataDir));
    await bootstrap(db);

    const meta = new MetaService();
    await meta.load(db);
    const acl = new AclService(meta);
    await acl.load(db);
    const hooks = new HookRegistry();
    registerMetadataHooks(hooks);
    registerSecurityHooks(hooks);
    const engine = new DataEngine(db, meta, hooks, acl);
    const instance = new Instance(db, meta, hooks, acl, engine, new MetaApi(engine), new AuthService(engine, acl, opts));
    await instance.ensureAdminPassword(opts.adminPassword);
    return instance;
  }

  /** ACL-enforcing session for a user (as if they had logged in). */
  sessionFor(userName: string): Promise<Session> {
    return this.auth.sessionFor({ userName });
  }

  glideRecord(table: string, session: Session = SYSTEM_SESSION): GlideRecord {
    return new GlideRecord(this.engine, table, session);
  }

  close(): Promise<void> {
    return this.db.close();
  }

  private async ensureAdminPassword(password: string | undefined): Promise<void> {
    const res = await this.db.query<{ sys_id: string; user_password: string | null }>(
      `SELECT "sys_id", "user_password" FROM "sys_user" WHERE "user_name" = 'admin'`,
    );
    const admin = res.rows[0];
    if (!admin || admin.user_password) return;
    const value = password ?? randomBytes(12).toString('base64url');
    await this.db.query(`UPDATE "sys_user" SET "user_password" = $1 WHERE "sys_id" = $2`, [await hashPassword(value), admin.sys_id]);
    if (password === undefined) this.generatedAdminPassword = value;
  }
}
