/**
 * Who is performing an operation, and with which privileges.
 *
 * - User sessions are built by the AuthService from sys_user + roles + groups.
 *   Every read and write made with a user session is checked against ACLs.
 * - System sessions (`system: true`) are platform-internal: they bypass ACLs, the
 *   way server-side GlideRecord does in ServiceNow (GlideRecordSecure is the
 *   ACL-enforcing variant). Untrusted entry points (HTTP, later sandboxed
 *   scripts) must never construct one.
 */
export interface Session {
  readonly userName: string;
  /** sys_user.sys_id; null for system sessions. */
  readonly userId: string | null;
  /** Effective role names (direct, via groups, and contained roles). */
  readonly roles: ReadonlySet<string>;
  /** sys_ids of the active groups the user belongs to. */
  readonly groups: ReadonlySet<string>;
  /** Platform-internal context that bypasses ACLs. */
  readonly system: boolean;
  /**
   * True when this session was derived for server-side GlideRecord inside a sandboxed
   * script: normal table/field ACLs are bypassed like ServiceNow's GlideRecord, but
   * platform security boundaries (sys_security_acl, sys_user_session, elevated roles)
   * are still enforced against `roles`.
   */
  readonly script?: boolean;
  /** Set while an admin impersonates this user: the real user behind the session. */
  readonly impersonator?: { readonly userId: string; readonly userName: string };
}

const EMPTY: ReadonlySet<string> = Object.freeze(new Set<string>());

/** A privileged, ACL-bypassing session. `userName` only controls attribution (sys_created_by, audit). */
export function systemSession(userName = 'system'): Session {
  return Object.freeze({ userName, userId: null, roles: EMPTY, groups: EMPTY, system: true });
}

/**
 * Session used by server-side GlideRecord inside sandboxed scripts.
 * Bypasses normal table/field ACLs (`system: true`), while still enforcing
 * elevated-role (`security_admin`) and `sys_user_session` guards (`script: true`).
 */
export function scriptSession(caller: Session, keepRoles = false): Session {
  return Object.freeze({
    userName: caller.userName,
    userId: caller.userId,
    roles: keepRoles ? caller.roles : EMPTY,
    groups: caller.groups,
    system: true,
    script: true,
    impersonator: caller.impersonator,
  });
}

export const SYSTEM_SESSION: Session = systemSession();
