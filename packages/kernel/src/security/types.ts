import type { QueryAst } from '@steward/shared';

export type AclOperation = 'read' | 'write' | 'create' | 'delete';
export const ACL_OPERATIONS: readonly AclOperation[] = ['read', 'write', 'create', 'delete'];

/**
 * Outcome of an ACL evaluation for one (table|field, operation):
 * - true:  allowed for every row
 * - false: denied for every row
 * - QueryAst[]: allowed only for rows matching at least one of these conditions
 *   (already resolved for the session, i.e. no `javascript:` values left)
 */
export type AccessDecision = boolean | QueryAst[];

/** What the query compiler needs to know to enforce read ACLs. */
export interface ReadAccess {
  /** Rows of `table` the caller may read (applied to the base table and to every dot-walk join). */
  rows(table: string): AccessDecision;
  /** Whether the caller may read `element` when reached through `table`. */
  field(table: string, element: string): AccessDecision;
}
