/**
 * Encoded query support, compatible with the ServiceNow encoded-query syntax.
 *
 *   active=true^priority<=2^ORpriority=5^NQshort_descriptionLIKEvpn^ORDERBYDESCsys_created_on
 *
 * Structure of the parsed AST:
 *   groups   - OR'ed together            (separated by ^NQ)
 *   clauses  - AND'ed within a group     (separated by ^)
 *   conds    - OR'ed within a clause     (separated by ^OR)
 *
 * Field names are always lowercase (a-z, 0-9, _, and '.' for dot-walking) and
 * operators are uppercase/symbolic, which is what makes the syntax unambiguous.
 * A literal '^' inside a value is escaped as '^^'.
 */

export const OPERATORS = [
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'LIKE',
  'NOT LIKE',
  'STARTSWITH',
  'ENDSWITH',
  'IN',
  'NOT IN',
  'ISEMPTY',
  'ISNOTEMPTY',
  'INSTANCEOF',
] as const;

export type Operator = (typeof OPERATORS)[number];

const UNARY_OPERATORS: ReadonlySet<Operator> = new Set<Operator>(['ISEMPTY', 'ISNOTEMPTY']);
/** Longest first so that e.g. "<=" wins over "<" and "INSTANCEOF" over "IN". */
const OPERATORS_BY_LENGTH: readonly Operator[] = [...OPERATORS].sort((a, b) => b.length - a.length);

const FIELD_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*/;
const FULL_FIELD_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;

export interface Condition {
  field: string;
  operator: Operator;
  value: string;
}

export interface OrderBy {
  field: string;
  desc: boolean;
}

export interface QueryAst {
  /** groups (OR, ^NQ) -> clauses (AND, ^) -> conditions (OR, ^OR) */
  groups: Condition[][][];
  orderBy: OrderBy[];
}

export class EncodedQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncodedQueryError';
  }
}

export function emptyQuery(): QueryAst {
  return { groups: [], orderBy: [] };
}

export function isUnaryOperator(op: Operator): boolean {
  return UNARY_OPERATORS.has(op);
}

/** Split on single '^', turning '^^' into a literal '^'. */
function splitTerms(input: string): string[] {
  const terms: string[] = [];
  let current = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '^') {
      if (input[i + 1] === '^') {
        current += '^';
        i++;
        continue;
      }
      terms.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  terms.push(current);
  return terms;
}

function parseField(raw: string): string {
  if (!FULL_FIELD_RE.test(raw)) throw new EncodedQueryError(`Invalid field name "${raw}"`);
  return raw;
}

export function parseCondition(term: string): Condition {
  const match = FIELD_RE.exec(term);
  if (!match) throw new EncodedQueryError(`Invalid query term "${term}"`);
  const field = match[0];
  const rest = term.slice(field.length);
  for (const operator of OPERATORS_BY_LENGTH) {
    if (!rest.startsWith(operator)) continue;
    const value = rest.slice(operator.length);
    if (UNARY_OPERATORS.has(operator)) {
      if (value !== '') continue;
      return { field, operator, value: '' };
    }
    return { field, operator, value };
  }
  throw new EncodedQueryError(`Missing or unknown operator in query term "${term}"`);
}

export function parseEncodedQuery(input: string | null | undefined): QueryAst {
  const ast = emptyQuery();
  if (!input) return ast;

  let group: Condition[][] = [];
  const flush = () => {
    if (group.length > 0) ast.groups.push(group);
    group = [];
  };

  for (const term of splitTerms(input)) {
    if (term === '' || term === 'EQ') continue;

    if (term.startsWith('ORDERBYDESC')) {
      ast.orderBy.push({ field: parseField(term.slice('ORDERBYDESC'.length)), desc: true });
      continue;
    }
    if (term.startsWith('ORDERBY')) {
      ast.orderBy.push({ field: parseField(term.slice('ORDERBY'.length)), desc: false });
      continue;
    }
    if (term.startsWith('NQ')) {
      flush();
      const rest = term.slice(2);
      if (rest !== '') group.push([parseCondition(rest)]);
      continue;
    }
    if (term.startsWith('OR')) {
      const last = group[group.length - 1];
      if (!last) throw new EncodedQueryError('^OR must follow another condition');
      last.push(parseCondition(term.slice(2)));
      continue;
    }
    group.push([parseCondition(term)]);
  }
  flush();
  return ast;
}

const escapeValue = (v: string) => v.replaceAll('^', '^^');

export function stringifyCondition(c: Condition): string {
  return `${c.field}${c.operator}${escapeValue(c.value)}`;
}

export function stringifyEncodedQuery(ast: QueryAst): string {
  let out = '';
  ast.groups.forEach((group, gi) => {
    group.forEach((clause, ci) => {
      clause.forEach((cond, i) => {
        const s = stringifyCondition(cond);
        if (i > 0) out += `^OR${s}`;
        else if (ci === 0 && gi > 0) out += `^NQ${s}`;
        else if (ci === 0 && gi === 0) out += s;
        else out += `^${s}`;
      });
    });
  });
  for (const o of ast.orderBy) {
    out += `${out ? '^' : ''}ORDERBY${o.desc ? 'DESC' : ''}${o.field}`;
  }
  return out;
}
