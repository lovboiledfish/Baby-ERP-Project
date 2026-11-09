import type { QueryAst } from '@steward/shared';
import type { Session } from '../session';

export type AclOperation = 'read' | 'write' | 'create' | 'delete';
export const ACL_OPERATIONS: readonly AclOperation[] = ['read', 'write', 'create', 'delete'];

/** One role-passing ACL rule when at least one rule at the decisive level has a script. */
export interface ScriptedAccessClause {
  readonly aclId: string;
  readonly name: string;
  readonly condition: QueryAst | null;
  readonly script: string | null;
}

export interface ScriptedAccess {
  readonly kind: 'scripted';
  readonly session: Session;
  /**
   * Necessary SQL conditions (disjunction) when every clause has an encoded-query condition;
   * null when at least one clause has no condition (only a script).
   */
  readonly sqlConditions: QueryAst[] | null;
  readonly clauses: readonly ScriptedAccessClause[];
}

/**
 * Outcome of an ACL evaluation for one (table|field, operation):
 * - true:  allowed for every row
 * - false: denied for every row
 * - QueryAst[]: allowed only for rows matching at least one of these conditions
 *   (already resolved for the session, i.e. no `javascript:` values left)
 * - ScriptedAccess: allowed for rows where at least one clause passes (condition AND script)
 */
export type AccessDecision = boolean | QueryAst[] | ScriptedAccess;

export function isScriptedAccess(d: AccessDecision): d is ScriptedAccess {
  return typeof d === 'object' && !Array.isArray(d) && d.kind === 'scripted';
}

/** What the query compiler needs to know to enforce read ACLs. */
export interface ReadAccess {
  /** Rows of `table` the caller may read (applied to the base table and to every dot-walk join). */
  rows(table: string): AccessDecision;
  /** Whether the caller may read `element` when reached through `table`. */
  field(table: string, element: string): AccessDecision;
}
