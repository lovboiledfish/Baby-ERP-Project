import { createHash, randomBytes } from 'node:crypto';
import type { DataEngine } from '../data/data-engine';
import { writeAudit } from '../data/audit';
import type { Db } from '../db/db';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../errors';
import { systemSession, type Session } from '../session';
import { ADMIN_ROLE, type AclService } from './acl-service';
import { verifyPassword } from './password';

export const IMPERSONATOR_ROLE = 'impersonator';
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

interface UserRow {
  sys_id: string;
  user_name: string;
  active: boolean | null;
  locked_out: boolean | null;
  user_password: string | null;
}

interface SessionRow {
  sys_id: string;
  user: string;
  impersonating: string | null;
  expires: Date | string;
}

export interface LoginResult {
  token: string;
  expires: string;
  session: Session;
}

export interface AuthOptions {
  /** Lifetime of tokens issued by login(). Default 8 hours. */
  sessionTtlMs?: number;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const invalid = () => new UnauthorizedError('Invalid credentials');

/**
 * Authentication and session building.
 *
 * - Passwords are verified against sys_user.user_password (scrypt).
 * - Tokens are random 256-bit bearer secrets; only their SHA-256 is stored in
 *   sys_user_session, so a database leak does not leak usable tokens.
 * - A Session is rebuilt from the database on every resolve, so deactivating a
 *   user or revoking a role takes effect on their next request.
 */
export class AuthService {
  private readonly ttl: number;

  constructor(
    private readonly engine: DataEngine,
    private readonly acl: AclService,
    opts: AuthOptions = {},
  ) {
    this.ttl = opts.sessionTtlMs ?? DEFAULT_TTL_MS;
  }

  private get db(): Db {
    return this.engine.db;
  }

  /** Build the effective session (roles via groups and role containment) for an active user. */
  async sessionFor(user: { userName: string } | { userId: string }, impersonator?: Session['impersonator']): Promise<Session> {
    const row = 'userId' in user ? await this.userById(user.userId) : await this.userByName(user.userName);
    if (!row || row.active === false || row.locked_out === true) throw invalid();
    return this.buildSession(row, impersonator);
  }

  /** Verify a user name + password (Basic auth, login). */
  async authenticate(userName: string, password: string): Promise<Session> {
    const row = await this.userByName(userName);
    const ok = await verifyPassword(password, row?.user_password);
    if (!row || !ok || row.active === false || row.locked_out === true) throw invalid();
    return this.buildSession(row);
  }

  async login(userName: string, password: string): Promise<LoginResult> {
    const session = await this.authenticate(userName, password);
    const token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + this.ttl).toISOString();
    await this.engine.insert('sys_user_session', { user: session.userId, token_hash: hashToken(token), expires }, systemSession(session.userName));
    return { token, expires, session };
  }

  /** Session for a bearer token (the impersonated user's session while impersonating). */
  async resolveToken(token: string): Promise<Session> {
    const row = await this.sessionRow(token);
    if (!row.impersonating) return this.sessionFor({ userId: row.user });
    const real = await this.sessionFor({ userId: row.user });
    const target = this.mayImpersonate(real)
      ? await this.sessionFor({ userId: row.impersonating }, { userId: real.userId!, userName: real.userName }).catch((e: unknown) => {
          if (e instanceof UnauthorizedError) return null; // target deactivated / locked out
          throw e;
        })
      : null;
    if (!target || !this.mayImpersonateTarget(real, target)) {
      // The real user lost the right to impersonate, or the target became more
      // privileged than the real user may assume: fall back to their own identity.
      await this.db.query(`UPDATE "sys_user_session" SET "impersonating" = NULL WHERE "sys_id" = $1`, [row.sys_id]);
      return real;
    }
    return target;
  }

  async logout(token: string): Promise<void> {
    await this.db.query(`DELETE FROM "sys_user_session" WHERE "token_hash" = $1`, [hashToken(token)]);
  }

  /**
   * Switch a token's effective identity to another user. Requires admin or
   * impersonator on the *real* user; non-admins cannot impersonate admins or
   * holders of elevated roles. Start and end are written to sys_audit.
   */
  async impersonate(token: string, targetUserName: string): Promise<Session> {
    const row = await this.sessionRow(token);
    const real = await this.sessionFor({ userId: row.user });
    if (!this.mayImpersonate(real)) throw new ForbiddenError('Not authorized to impersonate');
    const targetRow = await this.userByName(targetUserName);
    if (!targetRow || targetRow.active === false || targetRow.locked_out === true) {
      throw new ValidationError(`User ${targetUserName} does not exist or is not active`);
    }
    const target = await this.buildSession(targetRow, { userId: real.userId!, userName: real.userName });
    if (!this.mayImpersonateTarget(real, target)) throw new ForbiddenError(`Not authorized to impersonate ${targetUserName}`);

    await this.engine.transaction(async (e) => {
      await e.db.query(`UPDATE "sys_user_session" SET "impersonating" = $1 WHERE "sys_id" = $2`, [target.userId, row.sys_id]);
      await writeAudit(e.db, real.userName, [
        { table: 'sys_user', documentKey: target.userId!, field: 'impersonation', oldValue: real.userName, newValue: target.userName, checkpoint: 0, reason: 'impersonation started' },
      ]);
    });
    return target;
  }

  async endImpersonation(token: string): Promise<Session> {
    const row = await this.sessionRow(token);
    const real = await this.sessionFor({ userId: row.user });
    if (row.impersonating) {
      const target = await this.userById(row.impersonating);
      await this.engine.transaction(async (e) => {
        await e.db.query(`UPDATE "sys_user_session" SET "impersonating" = NULL WHERE "sys_id" = $1`, [row.sys_id]);
        await writeAudit(e.db, real.userName, [
          { table: 'sys_user', documentKey: row.impersonating!, field: 'impersonation', oldValue: target?.user_name ?? null, newValue: real.userName, checkpoint: 0, reason: 'impersonation ended' },
        ]);
      });
    }
    return real;
  }

  /** Remove expired tokens. Returns how many were deleted. */
  async purgeExpired(): Promise<number> {
    const res = await this.db.query(`DELETE FROM "sys_user_session" WHERE "expires" <= now()`);
    return res.affectedRows;
  }

  private mayImpersonate(real: Session): boolean {
    return real.roles.has(ADMIN_ROLE) || real.roles.has(IMPERSONATOR_ROLE);
  }

  /**
   * Impersonation must never grant more than the real user could get otherwise:
   * only admins may impersonate admins / holders of elevated roles, and nobody
   * may impersonate a holder of an elevated role they do not hold themselves.
   */
  private mayImpersonateTarget(real: Session, target: Session): boolean {
    const elevated = [...target.roles].filter((r) => this.acl.isElevated(r));
    const privileged = target.roles.has(ADMIN_ROLE) || elevated.length > 0;
    if (privileged && !real.roles.has(ADMIN_ROLE)) return false;
    return elevated.every((r) => real.roles.has(r));
  }

  private async sessionRow(token: string): Promise<SessionRow> {
    if (!token) throw new UnauthorizedError('Invalid or expired token');
    const res = await this.db.query<SessionRow>(
      `SELECT "sys_id", "user", "impersonating", "expires" FROM "sys_user_session" WHERE "token_hash" = $1`,
      [hashToken(token)],
    );
    const row = res.rows[0];
    if (!row) throw new UnauthorizedError('Invalid or expired token');
    if (new Date(row.expires).getTime() <= Date.now()) {
      await this.db.query(`DELETE FROM "sys_user_session" WHERE "sys_id" = $1`, [row.sys_id]);
      throw new UnauthorizedError('Invalid or expired token');
    }
    return row;
  }

  private async userByName(userName: string): Promise<UserRow | null> {
    const res = await this.db.query<UserRow>(
      `SELECT "sys_id", "user_name", "active", "locked_out", "user_password" FROM "sys_user" WHERE "user_name" = $1`,
      [userName],
    );
    return res.rows[0] ?? null;
  }

  private async userById(userId: string): Promise<UserRow | null> {
    const res = await this.db.query<UserRow>(
      `SELECT "sys_id", "user_name", "active", "locked_out", "user_password" FROM "sys_user" WHERE "sys_id" = $1`,
      [userId],
    );
    return res.rows[0] ?? null;
  }

  private async buildSession(user: UserRow, impersonator?: Session['impersonator']): Promise<Session> {
    const groups = await this.db.query<{ group: string }>(
      `SELECT m."group" FROM "sys_user_grmember" m JOIN "sys_user_group" g ON g."sys_id" = m."group"
        WHERE m."user" = $1 AND g."active" IS NOT FALSE`,
      [user.sys_id],
    );
    const groupIds = groups.rows.map((r) => r.group);
    const direct = await this.db.query<{ role: string }>(
      `SELECT "role" FROM "sys_user_has_role" WHERE "user" = $1
       UNION
       SELECT gr."role" FROM "sys_group_has_role" gr JOIN "sys_user_grmember" m ON m."group" = gr."group"
         JOIN "sys_user_group" g ON g."sys_id" = gr."group"
        WHERE m."user" = $1 AND g."active" IS NOT FALSE`,
      [user.sys_id],
    );
    // Expand contained roles (role hierarchy) transitively.
    const contains = await this.db.query<{ role: string; contains: string }>(`SELECT "role", "contains" FROM "sys_user_role_contains"`);
    const children = new Map<string, string[]>();
    for (const c of contains.rows) children.set(c.role, [...(children.get(c.role) ?? []), c.contains]);
    const roleIds = new Set<string>();
    const queue = direct.rows.map((r) => r.role);
    while (queue.length) {
      const id = queue.pop()!;
      if (roleIds.has(id)) continue;
      roleIds.add(id);
      queue.push(...(children.get(id) ?? []));
    }
    const names = await this.db.query<{ sys_id: string; name: string }>(`SELECT "sys_id", "name" FROM "sys_user_role"`);
    const roles = new Set(names.rows.filter((r) => roleIds.has(r.sys_id)).map((r) => r.name));

    return Object.freeze({
      userName: user.user_name,
      userId: user.sys_id,
      roles: Object.freeze(roles) as ReadonlySet<string>,
      groups: Object.freeze(new Set(groupIds)) as ReadonlySet<string>,
      system: false,
      ...(impersonator ? { impersonator: Object.freeze({ ...impersonator }) } : {}),
    });
  }
}
