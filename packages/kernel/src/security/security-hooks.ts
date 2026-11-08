import { EncodedQueryError, parseEncodedQuery } from '@steward/shared';
import type { HookRegistry, SystemHook } from '../data/hooks';
import { compileSelect } from '../data/query-compiler';
import { ForbiddenError, StewardError, ValidationError } from '../errors';
import { SYSTEM_SESSION } from '../session';
import { parseAclName } from './acl-service';
import { resolveDynamic } from './dynamic';

const ACL_TABLE_RE = /^(\*|[a-z][a-z0-9_]*)$/;
const ACL_FIELD_RE = /^(\*|[a-z][a-z0-9_]*)$/;

/**
 * Hooks that keep the ACL cache in sync with sys_security_acl, sys_security_acl_role
 * and sys_user_role, and validate ACL definitions before they are saved.
 */
export function securityHooks(): SystemHook[] {
  const reload: SystemHook['run'] = async ({ engine }) => {
    await engine.acl.load(engine.db);
  };
  return [
    {
      name: 'sys_security_acl: validate',
      table: 'sys_security_acl',
      when: 'before',
      operations: ['insert', 'update'],
      run({ engine, current }) {
        const { meta } = engine;
        const name = String(current.name ?? '').trim();
        const { table, field } = parseAclName(name);
        if (!ACL_TABLE_RE.test(table) || (field !== null && !ACL_FIELD_RE.test(field))) {
          throw new ValidationError(`Invalid ACL name "${name}"`, 'Use table, table.field, table.*, * or *.*');
        }
        if (table !== '*' && !meta.hasTable(table)) throw new ValidationError(`ACL ${name}: table ${table} does not exist`);
        if (table !== '*' && field !== null && field !== '*' && !meta.fields(table).has(field)) {
          throw new ValidationError(`ACL ${name}: field ${table}.${field} does not exist`);
        }
        current.name = name;

        const condition = typeof current.condition === 'string' ? current.condition.trim() : '';
        if (!condition) return;
        if (table === '*') throw new ValidationError(`ACL ${name}: conditions are not supported on * rules`);
        try {
          const ast = resolveDynamic(parseEncodedQuery(condition), SYSTEM_SESSION);
          compileSelect(meta, { table, query: ast, fields: ['sys_id'] });
        } catch (e) {
          if (e instanceof EncodedQueryError || e instanceof StewardError) {
            throw new ValidationError(`ACL ${name}: invalid condition`, e.message);
          }
          throw e;
        }
      },
    },
    { name: 'sys_security_acl: reload cache', table: 'sys_security_acl', when: 'after', operations: ['insert', 'update', 'delete'], run: reload },
    { name: 'sys_security_acl_role: reload cache', table: 'sys_security_acl_role', when: 'after', operations: ['insert', 'update', 'delete'], run: reload },
    { name: 'sys_user_role: reload cache', table: 'sys_user_role', when: 'after', operations: ['insert', 'update', 'delete'], run: reload },
    ...elevatedRoleGuards(),
  ];
}

type Engine = Parameters<SystemHook['run']>[0]['engine'];
type HookSession = Parameters<SystemHook['run']>[0]['session'];

/**
 * Names of the elevated roles reachable from `roleIds` through role containment
 * (the roles themselves included). Containment is transitive, so granting a role
 * that (indirectly) contains security_admin is the same as granting security_admin.
 */
export async function elevatedRolesWithin(db: Engine['db'], roleIds: Iterable<unknown>): Promise<string[]> {
  const start = [...roleIds].filter((r): r is string => typeof r === 'string');
  if (!start.length) return [];
  const contains = await db.query<{ role: string; contains: string }>(`SELECT "role", "contains" FROM "sys_user_role_contains"`);
  const children = new Map<string, string[]>();
  for (const c of contains.rows) children.set(c.role, [...(children.get(c.role) ?? []), c.contains]);
  const seen = new Set<string>();
  const queue = [...start];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  const elevated = await db.query<{ sys_id: string; name: string }>(`SELECT "sys_id", "name" FROM "sys_user_role" WHERE "elevated_privilege" IS TRUE`);
  return elevated.rows.filter((r) => seen.has(r.sys_id)).map((r) => r.name);
}

/** Elevated roles a user effectively holds (direct, via active groups, via containment). */
export async function elevatedRolesOfUser(db: Engine['db'], userId: string): Promise<string[]> {
  const direct = await db.query<{ role: string }>(
    `SELECT "role" FROM "sys_user_has_role" WHERE "user" = $1
     UNION
     SELECT gr."role" FROM "sys_group_has_role" gr JOIN "sys_user_grmember" m ON m."group" = gr."group"
       JOIN "sys_user_group" g ON g."sys_id" = gr."group"
      WHERE m."user" = $1 AND g."active" IS NOT FALSE`,
    [userId],
  );
  return elevatedRolesWithin(db, direct.rows.map((r) => r.role));
}

/**
 * Elevated roles (e.g. security_admin) may only be granted, contained, or
 * (un)flagged by someone who holds them, otherwise an admin could grant
 * themselves security_admin and step around the ACL protection. The checks
 * follow role containment transitively and also cover the indirect ways of
 * obtaining a privileged identity: group membership / reactivation, changing
 * the credentials of an elevated user, and forging or redirecting session tokens.
 * (Impersonation is guarded in AuthService.)
 */
function elevatedRoleGuards(): SystemHook[] {
  const deny = (what: string) => {
    throw new ForbiddenError(`Only holders of the elevated role can ${what}`);
  };
  const requireAll = (engine: Engine, session: HookSession, roles: string[], what: (role: string) => string) => {
    for (const role of roles) if (!engine.acl.hasRole(session, role)) deny(what(role));
  };
  const groupElevated = async (engine: Engine, group: unknown): Promise<string[]> => {
    if (typeof group !== 'string') return [];
    const res = await engine.db.query<{ role: string }>(`SELECT "role" FROM "sys_group_has_role" WHERE "group" = $1`, [group]);
    return elevatedRolesWithin(engine.db, res.rows.map((r) => r.role));
  };
  const guardRoleRef = (table: string, column: string): SystemHook => ({
    name: `${table}: guard elevated roles (${column})`,
    table,
    when: 'before',
    operations: ['insert', 'update', 'delete'],
    async run({ engine, session, current, previous }) {
      if (session.system) return;
      const roles = await elevatedRolesWithin(engine.db, new Set([current[column], previous?.[column]]));
      requireAll(engine, session, roles, (role) => `grant or revoke ${role}`);
    },
  });
  return [
    guardRoleRef('sys_user_has_role', 'role'),
    guardRoleRef('sys_group_has_role', 'role'),
    guardRoleRef('sys_user_role_contains', 'role'),
    guardRoleRef('sys_user_role_contains', 'contains'),
    {
      name: 'sys_user_grmember: guard groups with elevated roles',
      table: 'sys_user_grmember',
      when: 'before',
      operations: ['insert', 'update', 'delete'],
      async run({ engine, session, current, previous }) {
        if (session.system) return;
        for (const group of new Set([current.group, previous?.group])) {
          requireAll(engine, session, await groupElevated(engine, group), (role) => `change membership of a group that grants ${role}`);
        }
      },
    },
    {
      name: 'sys_user_group: guard reactivating groups with elevated roles',
      table: 'sys_user_group',
      when: 'before',
      operations: ['update'],
      async run({ engine, session, current, previous }) {
        if (session.system || !previous || previous.active !== false || current.active === false) return;
        requireAll(engine, session, await groupElevated(engine, previous.sys_id), (role) => `reactivate a group that grants ${role}`);
      },
    },
    {
      name: 'sys_user: guard credentials of elevated users',
      table: 'sys_user',
      when: 'before',
      operations: ['update'],
      async run({ engine, session, current, previous }) {
        if (session.system || !previous) return;
        // Password values are never loaded back, so any value here is a new password.
        const credentialsChange = current.user_password != null || current.user_name !== previous.user_name;
        if (!credentialsChange) return;
        const roles = await elevatedRolesOfUser(engine.db, String(previous.sys_id));
        requireAll(engine, session, roles, (role) => `change the credentials of a user holding ${role}`);
      },
    },
    {
      // Tokens are issued only by AuthService (system context). Letting users write
      // sessions would allow forging a token, or redirecting `impersonating`, for any user.
      name: 'sys_user_session: issued by the platform only',
      table: 'sys_user_session',
      when: 'before',
      operations: ['insert', 'update'],
      run({ session }) {
        if (!session.system) throw new ForbiddenError('Sessions can only be created or changed by logging in');
      },
    },
    {
      name: 'sys_user_role: guard elevated flag',
      table: 'sys_user_role',
      when: 'before',
      operations: ['insert', 'update', 'delete'],
      run({ engine, session, current, previous }) {
        if (session.system) return;
        const name = String(previous?.name ?? current.name ?? '');
        const touchesElevated = current.elevated_privilege === true || previous?.elevated_privilege === true;
        if (touchesElevated && !engine.acl.hasRole(session, name)) deny(`modify the elevated role ${name}`);
      },
    },
  ];
}

export function registerSecurityHooks(registry: HookRegistry): void {
  registry.register(...securityHooks());
}
