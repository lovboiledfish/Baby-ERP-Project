import { isUnaryOperator, stringifyEncodedQuery, type Operator } from '@steward/shared';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import {
  astToBuilder,
  blankRow,
  builderToAst,
  filterableFields,
  OPERATOR_LABELS,
  operatorsFor,
  safeParse,
  type Builder,
  type CondField,
  type CondRow,
} from '../lib/conditions';
import { ReferencePicker } from './ReferencePicker';

interface Props {
  fields: CondField[];
  query: string;
  onRun: (query: string) => void;
}

/**
 * ServiceNow-style condition builder: rows are AND-ed, "or" adds an alternative to a
 * row, "New criteria" starts an OR-ed group (^NQ). Produces an encoded query; the
 * current sort order is kept.
 */
export function ConditionBuilder({ fields, query, onRun }: Props) {
  const usable = filterableFields(fields);
  const initial = safeParse(query);
  const [builder, setBuilder] = useState<Builder>(() => {
    const b = astToBuilder(initial);
    return b.length ? b : [[[blankRow(usable)]]];
  });
  const [refDisplay, setRefDisplay] = useState<Record<number, string>>({});

  const update = (fn: (b: Builder) => void) =>
    setBuilder((prev) => {
      const next: Builder = prev.map((g) => g.map((cl) => cl.map((c) => ({ ...c }))));
      fn(next);
      return next.filter((g) => g.length > 0);
    });

  const fieldOf = (path: string) => usable.find((f) => f.element === path);

  useEffect(() => {
    let live = true;
    for (const group of builder) {
      for (const clause of group) {
        for (const row of clause) {
          const f = fieldOf(row.field);
          if (!f || f.type !== 'reference' || !f.reference || !f.referenceDisplayField || !row.value) continue;
          if (row.operator !== '=' && row.operator !== '!=') continue;
          const df = f.referenceDisplayField;
          api<Record<string, unknown>>(`/api/now/table/${f.reference}/${row.value}`, { query: { sysparm_fields: df } }).then(
            ({ data }) => live && setRefDisplay((m) => ({ ...m, [row.id]: String(data[df] ?? row.value) })),
            () => undefined,
          );
        }
      }
    }
    return () => {
      live = false;
    };
  }, []);

  const setRow = (gi: number, ci: number, oi: number, patch: Partial<CondRow>, display?: string) => {
    const rowId = builder[gi]?.[ci]?.[oi]?.id;
    if (rowId !== undefined) {
      if (display !== undefined) {
        setRefDisplay((m) => ({ ...m, [rowId]: display }));
      } else if (patch.field !== undefined || patch.value !== undefined || (patch.operator && isUnaryOperator(patch.operator))) {
        setRefDisplay((m) => {
          if (!(rowId in m)) return m;
          const next = { ...m };
          delete next[rowId];
          return next;
        });
      }
    }
    update((b) => {
      const row = b[gi]![ci]![oi]!;
      Object.assign(row, patch);
      if (patch.field !== undefined) {
        const f = fieldOf(patch.field);
        row.operator = f ? operatorsFor(f.type)[0]! : '=';
        row.value = '';
      }
      if (patch.operator && isUnaryOperator(patch.operator)) row.value = '';
    });
  };

  const remove = (gi: number, ci: number, oi: number) =>
    update((b) => {
      b[gi]![ci]!.splice(oi, 1);
      if (!b[gi]![ci]!.length) b[gi]!.splice(ci, 1);
    });

  const run = () => onRun(stringifyEncodedQuery(builderToAst(builder, initial.orderBy)));

  const valueEditor = (row: CondRow, gi: number, ci: number, oi: number) => {
    if (isUnaryOperator(row.operator)) return null;
    const f = fieldOf(row.field);
    const set = (value: string, display?: string) => setRow(gi, ci, oi, { value }, display);
    const label = `Value for ${f?.label ?? row.field}`;
    if (f?.type === 'boolean') {
      return (
        <select aria-label={label} value={row.value} onChange={(e) => set(e.target.value)}>
          <option value="">--</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    }
    if (f?.type === 'choice' && (row.operator === '=' || row.operator === '!=')) {
      return (
        <select aria-label={label} value={row.value} onChange={(e) => set(e.target.value)}>
          <option value="">--</option>
          {f.choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      );
    }
    if (f?.type === 'reference' && f.reference && (row.operator === '=' || row.operator === '!=')) {
      return (
        <ReferencePicker
          label={label}
          table={f.reference}
          displayField={f.referenceDisplayField ?? 'sys_id'}
          value={row.value || null}
          display={refDisplay[row.id] ?? row.value}
          onChange={(v, d) => set(v ?? '', d)}
        />
      );
    }
    const type = f?.type === 'date' ? 'date' : f?.type === 'integer' || f?.type === 'decimal' ? 'number' : 'text';
    return <input aria-label={label} type={type} value={row.value} onChange={(e) => set(e.target.value)} placeholder={row.operator.includes('IN') ? 'a,b,c' : ''} />;
  };

  return (
    <div className="condition-builder" aria-label="Condition builder" role="group">
      {builder.map((group, gi) => (
        <div className="cb-group" key={gi}>
          {gi > 0 && <div className="cb-nq">— or —</div>}
          {group.map((clause, ci) => (
            <div className="cb-clause" key={clause[0]?.id ?? ci}>
              {ci > 0 && <span className="cb-and">and</span>}
              {clause.map((row, oi) => {
                const f = fieldOf(row.field);
                const baseOps = f ? operatorsFor(f.type) : operatorsFor('string');
                const ops: Operator[] = baseOps.includes(row.operator) ? baseOps : [row.operator, ...baseOps];
                return (
                  <div className="cb-row" key={row.id} data-testid="cb-row">
                    {oi > 0 && <span className="cb-or">or</span>}
                    <select aria-label="Field" value={row.field} onChange={(e) => setRow(gi, ci, oi, { field: e.target.value })}>
                      {!f && <option value={row.field}>{row.field || '-- choose field --'}</option>}
                      {usable.map((x) => (
                        <option key={x.element} value={x.element}>
                          {x.label}
                        </option>
                      ))}
                    </select>
                    <select aria-label="Operator" value={row.operator} onChange={(e) => setRow(gi, ci, oi, { operator: e.target.value as Operator })}>
                      {ops.map((op) => (
                        <option key={op} value={op}>
                          {OPERATOR_LABELS[op]}
                        </option>
                      ))}
                    </select>
                    {valueEditor(row, gi, ci, oi)}
                    <button type="button" className="link" onClick={() => update((b) => b[gi]![ci]!.splice(oi + 1, 0, blankRow(usable)))}>
                      or
                    </button>
                    <button type="button" className="link" onClick={() => update((b) => b[gi]!.splice(ci + 1, 0, [blankRow(usable)]))}>
                      and
                    </button>
                    <button type="button" className="link danger" aria-label="Remove condition" onClick={() => remove(gi, ci, oi)}>
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}
      <div className="cb-actions">
        <button type="button" className="primary" onClick={run}>
          Run
        </button>
        <button type="button" onClick={() => update((b) => b.push([[blankRow(usable)]]))}>
          New criteria
        </button>
        <button type="button" onClick={() => setBuilder([[[blankRow(usable)]]])}>
          Clear
        </button>
      </div>
    </div>
  );
}
