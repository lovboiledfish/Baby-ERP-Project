import type { Condition, QueryAst } from '@steward/shared';
import { ValidationError } from '../errors';
import type { Session } from '../session';

/** Matches nothing: used for "me" when the session has no user (system context). */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

type Resolver = (s: Session) => string;

const SCALARS: Record<string, Resolver> = {
  'javascript:gs.getUserID()': (s) => s.userId ?? NIL_UUID,
  'javascript:gs.getUserName()': (s) => s.userName,
};

const LISTS: Record<string, Resolver> = {
  'javascript:getMyGroups()': (s) => [...s.groups].join(','),
  'javascript:gs.getUser().getMyGroups()': (s) => [...s.groups].join(','),
};

export const DYNAMIC_VALUES: readonly string[] = [...Object.keys(SCALARS), ...Object.keys(LISTS)];

function resolveCondition(c: Condition, session: Session): Condition {
  if (!c.value.startsWith('javascript:')) return c;
  const key = c.value.replace(/\s+/g, '');
  const scalar = SCALARS[key];
  if (scalar) return { ...c, value: scalar(session) };
  const list = LISTS[key];
  if (list) {
    // A list on the right of = / != means membership, as in ServiceNow.
    const operator = c.operator === '=' ? 'IN' : c.operator === '!=' ? 'NOT IN' : c.operator;
    return { ...c, operator, value: list(session) };
  }
  throw new ValidationError(
    `Unsupported dynamic query value "${c.value}"`,
    `Scripted values arrive with server scripting (Phase 4). Supported: ${DYNAMIC_VALUES.join(', ')}`,
  );
}

/**
 * Replace the small set of supported `javascript:` query values with values from
 * the session (current user, current user's groups). Returns the input unchanged
 * when there is nothing to resolve.
 */
export function resolveDynamic(ast: QueryAst, session: Session): QueryAst;
export function resolveDynamic(ast: QueryAst | undefined, session: Session): QueryAst | undefined;
export function resolveDynamic(ast: QueryAst | undefined, session: Session): QueryAst | undefined {
  if (!ast) return ast;
  if (!ast.groups.some((g) => g.some((cl) => cl.some((c) => c.value.startsWith('javascript:'))))) return ast;
  return {
    groups: ast.groups.map((g) => g.map((cl) => cl.map((c) => resolveCondition(c, session)))),
    orderBy: ast.orderBy,
  };
}
