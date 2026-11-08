import { parseEncodedQuery, type Condition, type Operator, type QueryAst, OPERATORS } from '@steward/shared';
import { ValidationError } from '../errors';
import { SYSTEM_SESSION, type Session } from '../session';
import type { DataEngine, RecordValues } from './data-engine';

const OPERATOR_SET: ReadonlySet<string> = new Set(OPERATORS);

interface Cell {
  value: unknown;
  display_value: string;
}

/** Fluent handle returned by addQuery() so that OR conditions can be attached. */
export class QueryCondition {
  constructor(private readonly clause: Condition[]) {}

  addOrCondition(field: string, opOrValue: unknown, value?: unknown): QueryCondition {
    this.clause.push(toCondition(field, opOrValue, value, arguments.length));
    return this;
  }
}

function toCondition(field: string, opOrValue: unknown, value: unknown, argc: number): Condition {
  if (argc >= 3) {
    const op = String(opOrValue);
    if (!OPERATOR_SET.has(op)) throw new ValidationError(`Unknown operator ${op}`);
    return { field, operator: op as Operator, value: value == null ? '' : String(value) };
  }
  return { field, operator: '=', value: opOrValue == null ? '' : String(opOrValue) };
}

/**
 * A GlideRecord-style API over the data engine (async flavour).
 * Phase 4 exposes a synchronous version of the same API inside script sandboxes.
 *
 *   const gr = instance.glideRecord('incident');
 *   gr.addQuery('priority', '<=', 2);
 *   await gr.query();
 *   while (gr.next()) console.log(gr.getValue('number'), gr.getDisplayValue('caller'));
 */
export class GlideRecord {
  private ast: QueryAst = { groups: [], orderBy: [] };
  private limit: number | undefined;
  private rows: Array<Record<string, Cell>> = [];
  private index = -1;
  private values: RecordValues = {};
  private display: Record<string, string> = {};
  private pending: RecordValues = {};
  private isNew = false;

  constructor(
    private readonly engine: DataEngine,
    readonly table: string,
    private readonly session: Session = SYSTEM_SESSION,
  ) {
    engine.meta.getTable(table); // validate eagerly
  }

  private get clauses(): Condition[][] {
    if (this.ast.groups.length === 0) this.ast.groups.push([]);
    return this.ast.groups[this.ast.groups.length - 1]!;
  }

  addQuery(field: string, opOrValue: unknown, value?: unknown): QueryCondition {
    const clause = [toCondition(field, opOrValue, value, arguments.length)];
    this.clauses.push(clause);
    return new QueryCondition(clause);
  }

  addEncodedQuery(query: string): void {
    const parsed = parseEncodedQuery(query);
    if (parsed.groups.length > 1 && this.ast.groups.some((g) => g.length)) {
      throw new ValidationError('Cannot merge a ^NQ query into an existing query');
    }
    if (parsed.groups.length > 1) this.ast.groups = parsed.groups;
    else if (parsed.groups.length === 1) this.clauses.push(...parsed.groups[0]!);
    this.ast.orderBy.push(...parsed.orderBy);
  }

  addNullQuery(field: string): void {
    this.clauses.push([{ field, operator: 'ISEMPTY', value: '' }]);
  }

  addNotNullQuery(field: string): void {
    this.clauses.push([{ field, operator: 'ISNOTEMPTY', value: '' }]);
  }

  orderBy(field: string): void {
    this.ast.orderBy.push({ field, desc: false });
  }

  orderByDesc(field: string): void {
    this.ast.orderBy.push({ field, desc: true });
  }

  setLimit(n: number): void {
    this.limit = n;
  }

  async query(): Promise<void> {
    const rows = await this.engine.query(this.table, { query: this.ast, limit: this.limit, displayValue: 'all' });
    this.rows = rows as Array<Record<string, Cell>>;
    this.index = -1;
    this.isNew = false;
  }

  /** Load a single record by sys_id, or by field/value. */
  async get(fieldOrSysId: string, value?: unknown): Promise<boolean> {
    this.ast = { groups: [], orderBy: [] };
    if (value === undefined) this.addQuery('sys_id', fieldOrSysId);
    else this.addQuery(fieldOrSysId, value);
    this.setLimit(1);
    await this.query();
    return this.next();
  }

  next(): boolean {
    if (this.index + 1 >= this.rows.length) return false;
    this.index++;
    const row = this.rows[this.index]!;
    this.values = Object.fromEntries(Object.entries(row).map(([k, c]) => [k, c.value]));
    this.display = Object.fromEntries(Object.entries(row).map(([k, c]) => [k, c.display_value]));
    this.pending = {};
    return true;
  }

  hasNext(): boolean {
    return this.index + 1 < this.rows.length;
  }

  getRowCount(): number {
    return this.rows.length;
  }

  initialize(): void {
    this.values = {};
    this.display = {};
    this.pending = {};
    this.isNew = true;
  }

  isNewRecord(): boolean {
    return this.isNew;
  }

  getValue(field: string): unknown {
    return field in this.pending ? this.pending[field] : (this.values[field] ?? null);
  }

  getDisplayValue(field?: string): string {
    if (!field) return this.display[this.engine.meta.displayField(this.table).element] ?? '';
    return field in this.pending ? String(this.pending[field] ?? '') : (this.display[field] ?? '');
  }

  getUniqueValue(): string {
    return String(this.getValue('sys_id') ?? '');
  }

  setValue(field: string, value: unknown): void {
    this.engine.meta.field(this.table, field);
    this.pending[field] = value;
  }

  async insert(): Promise<string> {
    const record = await this.engine.insert(this.table, { ...this.values, ...this.pending }, this.session);
    await this.reload(String(record.sys_id));
    return this.getUniqueValue();
  }

  async update(): Promise<string> {
    if (this.isNew || !this.values.sys_id) return this.insert();
    const sysId = String(this.values.sys_id);
    await this.engine.update(this.table, sysId, this.pending, this.session);
    await this.reload(sysId);
    return sysId;
  }

  async deleteRecord(): Promise<boolean> {
    if (!this.values.sys_id) return false;
    await this.engine.delete(this.table, String(this.values.sys_id), this.session);
    return true;
  }

  private async reload(sysId: string): Promise<void> {
    const row = await this.engine.get(this.table, sysId, { displayValue: 'all' });
    this.rows = row ? [row as Record<string, Cell>] : [];
    this.index = -1;
    this.isNew = false;
    this.next();
  }
}
