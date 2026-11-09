import {
  isUnaryOperator,
  parseEncodedQuery,
  stringifyEncodedQuery,
  type Condition,
  type FieldType,
  type Operator,
  type OrderBy,
  type QueryAst,
} from '@steward/shared';

/** The subset of field metadata the condition builder needs. */
export interface CondField {
  element: string;
  label: string;
  type: FieldType;
  reference: string | null;
  choices: Array<{ value: string; label: string }>;
  referenceDisplayField?: string | null;
}

export interface CondRow extends Condition {
  id: number;
}

/** groups (OR, ^NQ) -> clauses (AND, ^) -> conditions (OR, ^OR); same shape as QueryAst. */
export type Builder = CondRow[][][];

const TEXT_OPS: Operator[] = ['=', '!=', 'LIKE', 'NOT LIKE', 'STARTSWITH', 'ENDSWITH', 'IN', 'ISEMPTY', 'ISNOTEMPTY'];
const ORDERED_OPS: Operator[] = ['=', '!=', '<', '<=', '>', '>=', 'ISEMPTY', 'ISNOTEMPTY'];

/** Operators offered for a field type (all are understood by the server's query compiler). */
export function operatorsFor(type: FieldType): Operator[] {
  switch (type) {
    case 'integer':
    case 'decimal':
    case 'date':
    case 'datetime':
      return ORDERED_OPS;
    case 'boolean':
      return ['=', '!='];
    case 'choice':
      return ['=', '!=', 'IN', 'NOT IN', 'ISEMPTY', 'ISNOTEMPTY'];
    case 'reference':
    case 'guid':
      return ['=', '!=', 'IN', 'ISEMPTY', 'ISNOTEMPTY'];
    case 'sys_class_name':
      return ['=', '!=', 'INSTANCEOF'];
    default:
      return TEXT_OPS;
  }
}

export const OPERATOR_LABELS: Record<Operator, string> = {
  '=': 'is',
  '!=': 'is not',
  '<': 'less than',
  '<=': 'at most',
  '>': 'greater than',
  '>=': 'at least',
  LIKE: 'contains',
  'NOT LIKE': 'does not contain',
  STARTSWITH: 'starts with',
  ENDSWITH: 'ends with',
  IN: 'is one of',
  'NOT IN': 'is not one of',
  ISEMPTY: 'is empty',
  ISNOTEMPTY: 'is not empty',
  INSTANCEOF: 'is a',
};

/** Fields that make sense in a filter. */
export function filterableFields<F extends CondField>(fields: F[]): F[] {
  return fields.filter((f) => f.type !== 'password' && f.type !== 'journal').sort((a, b) => a.label.localeCompare(b.label));
}

let seq = 0;
export const newRow = (c: Condition): CondRow => ({ ...c, id: ++seq });

export function blankRow(fields: CondField[]): CondRow {
  const f = fields[0];
  return newRow({ field: f?.element ?? '', operator: f ? operatorsFor(f.type)[0]! : '=', value: '' });
}

export function astToBuilder(ast: QueryAst): Builder {
  return ast.groups.map((g) => g.map((clause) => clause.map(newRow)));
}

export function builderToAst(builder: Builder, orderBy: OrderBy[] = []): QueryAst {
  const complete = (c: CondRow) => c.field !== '' && (isUnaryOperator(c.operator) || c.value !== '');
  const groups = builder
    .map((g) =>
      g
        .map((clause) => clause.filter(complete).map(({ field, operator, value }) => ({ field, operator, value: isUnaryOperator(operator) ? '' : value })))
        .filter((clause) => clause.length > 0),
    )
    .filter((g) => g.length > 0);
  return { groups, orderBy };
}

/** Parse leniently: an unparsable query yields an empty filter instead of crashing the page. */
export function safeParse(query: string): QueryAst {
  try {
    return parseEncodedQuery(query);
  } catch {
    return { groups: [], orderBy: [] };
  }
}

/** Replace the sort of an encoded query. */
export function withOrder(query: string, field: string, desc: boolean): string {
  const ast = safeParse(query);
  return stringifyEncodedQuery({ ...ast, orderBy: [{ field, desc }] });
}

/** AND an extra encoded query onto another one (each may contain ^NQ groups and ORDERBY). */
export function andQueries(base: string, extra: string): string {
  const a = safeParse(base);
  const b = safeParse(extra);
  if (!a.groups.length) return stringifyEncodedQuery({ groups: b.groups, orderBy: [...a.orderBy, ...b.orderBy] });
  if (!b.groups.length) return stringifyEncodedQuery({ groups: a.groups, orderBy: [...a.orderBy, ...b.orderBy] });
  // (A1 OR A2) AND (B1 OR B2) = A1B1 OR A1B2 OR A2B1 OR A2B2
  const groups = a.groups.flatMap((ga) => b.groups.map((gb) => [...ga, ...gb]));
  return stringifyEncodedQuery({ groups, orderBy: [...a.orderBy, ...b.orderBy] });
}

function fieldLabel(path: string, fields: CondField[]): string {
  return fields.find((f) => f.element === path)?.label ?? path;
}

function valueLabel(c: Condition, fields: CondField[]): string {
  const f = fields.find((x) => x.element === c.field);
  if (f?.type === 'choice') {
    return c.value
      .split(',')
      .map((v) => f.choices.find((ch) => ch.value === v)?.label ?? v)
      .join(', ');
  }
  return c.value;
}

export function describeCondition(c: Condition, fields: CondField[]): string {
  const op = OPERATOR_LABELS[c.operator];
  return isUnaryOperator(c.operator) ? `${fieldLabel(c.field, fields)} ${op}` : `${fieldLabel(c.field, fields)} ${op} ${valueLabel(c, fields)}`;
}

export interface Crumb {
  label: string;
  /** Encoded query of everything up to and including this crumb. */
  query: string;
}

/**
 * Breadcrumbs for a list filter. A single-group query gives one crumb per AND
 * clause (clicking one drops the clauses after it); queries with ^NQ groups
 * are shown as a single crumb. Sorting is kept on every crumb.
 */
export function breadcrumbs(query: string, fields: CondField[]): Crumb[] {
  const ast = safeParse(query);
  if (!ast.groups.length) return [];
  if (ast.groups.length > 1) {
    const label = ast.groups.map((g) => g.map((cl) => cl.map((c) => describeCondition(c, fields)).join(' or ')).join(' and ')).join(' — or — ');
    return [{ label, query: stringifyEncodedQuery(ast) }];
  }
  const clauses = ast.groups[0]!;
  return clauses.map((_, i) => ({
    label: clauses[i]!.map((c) => describeCondition(c, fields)).join(' or '),
    query: stringifyEncodedQuery({ groups: [clauses.slice(0, i + 1)], orderBy: ast.orderBy }),
  }));
}

/** Values for prefilling a new record from `field=value` clauses (as related lists' New buttons do). */
export function prefillFromQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  const ast = safeParse(query);
  if (ast.groups.length !== 1) return out;
  for (const clause of ast.groups[0]!) {
    const c = clause[0];
    if (clause.length === 1 && c && c.operator === '=' && !c.field.includes('.')) out[c.field] = c.value;
  }
  return out;
}
