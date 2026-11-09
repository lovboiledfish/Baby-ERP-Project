import { EncodedQueryError, parseEncodedQuery, type QueryAst } from '@steward/shared';
import type { Db } from '../db/db';
import type { MetaService } from '../meta/meta-service';
import { checkScriptSyntax } from '../script/sandbox';
import type { Session } from '../session';
import { resolveDynamic } from './dynamic';
import { ACL_OPERATIONS, type AccessDecision, type AclOperation, type ReadAccess, type ScriptedAccessClause } from './types';

export interface AclRule {
  sysId: string;
  /** "incident", "incident.priority", "incident.*", "*", "*.*" */
  name: string;
  operation: AclOperation;
  adminOverrides: boolean;
  /** Parsed condition; null = no condition. */
  condition: QueryAst | null;
  /** Optional sandbox script; null = no script. */
  script: string | null;
  /** The stored condition or script could not be parsed: the rule never passes (fail closed). */
  broken: boolean;
  /** Role names; the rule passes the role check if empty or the user has any of them. */
  roles: string[];
}

interface AclRow {
  sys_id: string;
  name: string;
  operation: string;
  admin_overrides: boolean | null;
  condition: string | null;
  script: string | null;
}

export const ADMIN_ROLE = 'admin';

/**
 * In-memory cache of sys_security_acl (+ roles) and the ACL evaluator.
 *
 * Resolution follows ServiceNow: walk from the most specific name to the most
 * generic one; the first level that has any active rule for the operation is
 * decisive, and access is granted if at least one rule at that level passes
 * (roles AND condition AND script).
 *
 *   table level: incident -> task -> *
 *   field level: incident.priority -> incident.* -> task.priority -> task.* -> *.priority -> *.*
 *
 * Defaults when no rule matches at any level: table-level operations are denied
 * (except for admin); field-level operations are allowed (the table-level check
 * already applies).
 *
 * The admin role satisfies every role requirement except elevated roles
 * (sys_user_role.elevated_privilege, e.g. security_admin), and passes every rule
 * that has admin_overrides=true.
 */
export class AclService {
  private rules = new Map<string, AclRule[]>();
  private elevated = new Set<string>();
  version = 0;

  constructor(private readonly meta: MetaService) {}

  async load(db: Db): Promise<void> {
    const acls = await db.query<AclRow>(
      `SELECT "sys_id", "name", "operation", "admin_overrides", "condition", "script" FROM "sys_security_acl" WHERE "active" IS NOT FALSE`,
    );
    const roleRows = await db.query<{ acl: string; role: string }>(
      `SELECT ar."sys_security_acl" AS acl, r."name" AS role
         FROM "sys_security_acl_role" ar JOIN "sys_user_role" r ON r."sys_id" = ar."sys_user_role"`,
    );
    const elevated = await db.query<{ name: string }>(`SELECT "name" FROM "sys_user_role" WHERE "elevated_privilege" IS TRUE`);

    const rolesByAcl = new Map<string, string[]>();
    for (const r of roleRows.rows) rolesByAcl.set(r.acl, [...(rolesByAcl.get(r.acl) ?? []), r.role]);

    const rules = new Map<string, AclRule[]>();
    for (const a of acls.rows) {
      if (!(ACL_OPERATIONS as readonly string[]).includes(a.operation)) continue;
      let condition: QueryAst | null = null;
      let broken = false;
      if (a.condition && a.condition.trim()) {
        try {
          condition = parseEncodedQuery(a.condition);
          if (condition.groups.length === 0) condition = null;
        } catch (e) {
          if (!(e instanceof EncodedQueryError)) throw e;
          broken = true;
        }
      }
      const script = a.script && a.script.trim() ? a.script : null;
      if (script) {
        try {
          checkScriptSyntax(script);
        } catch {
          broken = true;
        }
      }
      const rule: AclRule = {
        sysId: a.sys_id,
        name: a.name,
        operation: a.operation as AclOperation,
        adminOverrides: a.admin_overrides !== false,
        condition,
        script,
        broken,
        roles: rolesByAcl.get(a.sys_id) ?? [],
      };
      const key = `${rule.name}|${rule.operation}`;
      rules.set(key, [...(rules.get(key) ?? []), rule]);
    }
    this.rules = rules;
    this.elevated = new Set(elevated.rows.map((r) => r.name));
    this.version++;
  }

  isElevated(role: string): boolean {
    return this.elevated.has(role);
  }

  /** ServiceNow semantics: admin implicitly has every role except elevated ones. */
  hasRole(session: Session, role: string): boolean {
    if (session.system && !session.script) return true;
    if (session.roles.has(role)) return true;
    return session.roles.has(ADMIN_ROLE) && !this.elevated.has(role);
  }

  isAdmin(session: Session): boolean {
    return (session.system && !session.script) || session.roles.has(ADMIN_ROLE);
  }

  /** Rules matching an exact ACL name (for inspection and tests). */
  rulesFor(name: string, operation: AclOperation): readonly AclRule[] {
    return this.rules.get(`${name}|${operation}`) ?? [];
  }

  tableDecision(session: Session, table: string, operation: AclOperation): AccessDecision {
    if (session.system) return true;
    const levels = [...this.meta.ancestors(table).map((t) => t.name), '*'];
    return this.decide(session, levels, operation) ?? this.isAdmin(session);
  }

  fieldDecision(session: Session, table: string, element: string, operation: AclOperation): AccessDecision {
    if (session.system) return true;
    const levels: string[] = [];
    for (const t of this.meta.ancestors(table)) levels.push(`${t.name}.${element}`, `${t.name}.*`);
    levels.push(`*.${element}`, '*.*');
    // Field-level "create" falls back to "write" rules when no create rule exists.
    const decided = this.decide(session, levels, operation) ?? (operation === 'create' ? this.decide(session, levels, 'write') : undefined);
    return decided ?? true;
  }

  /** Read access adapter for the query compiler; undefined means unrestricted. */
  readAccess(session: Session): ReadAccess | undefined {
    if (session.system) return undefined;
    return {
      rows: (table) => this.tableDecision(session, table, 'read'),
      field: (table, element) => this.fieldDecision(session, table, element, 'read'),
    };
  }

  /** Returns undefined when no level has any rule for the operation. */
  private decide(session: Session, levels: string[], operation: AclOperation): AccessDecision | undefined {
    for (const level of levels) {
      const rules = this.rules.get(`${level}|${operation}`);
      if (!rules?.length) continue;
      return this.evaluateLevel(session, rules);
    }
    return undefined;
  }

  private evaluateLevel(session: Session, rules: AclRule[]): AccessDecision {
    const admin = this.isAdmin(session);
    const clauses: ScriptedAccessClause[] = [];
    for (const rule of rules) {
      if (admin && rule.adminOverrides) return true;
      if (rule.broken) continue;
      if (rule.roles.length > 0 && !rule.roles.some((r) => this.hasRole(session, r))) continue;
      if (!rule.condition && !rule.script) return true;
      clauses.push({
        aclId: rule.sysId,
        name: rule.name,
        condition: rule.condition ? resolveDynamic(rule.condition, session) : null,
        script: rule.script,
      });
    }
    if (clauses.length === 0) return false;
    if (!clauses.some((c) => c.script !== null)) {
      return clauses.map((c) => c.condition!);
    }
    const allHaveCond = clauses.every((c) => c.condition !== null);
    return {
      kind: 'scripted',
      session,
      sqlConditions: allHaveCond ? clauses.map((c) => c.condition!) : null,
      clauses,
    };
  }
}

/** Split an ACL name into table and field parts: "incident.priority" -> ["incident", "priority"]. */
export function parseAclName(name: string): { table: string; field: string | null } {
  const dot = name.indexOf('.');
  return dot === -1 ? { table: name, field: null } : { table: name.slice(0, dot), field: name.slice(dot + 1) };
}
