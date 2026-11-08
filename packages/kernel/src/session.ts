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
  /** Set while an admin impersonates this user: the real user behind the session. */
  readonly impersonator?: { readonly userId: string; readonly userName: string };
}

const EMPTY: ReadonlySet<string> = Object.freeze(new Set<string>());

/** A privileged, ACL-bypassing session. `userName` only controls attribution (sys_created_by, audit). */
export function systemSession(userName = 'system'): Session {
  return Object.freeze({ userName, userId: null, roles: EMPTY, groups: EMPTY, system: true });
}

export const SYSTEM_SESSION: Session = systemSession();
