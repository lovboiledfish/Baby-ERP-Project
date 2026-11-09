import type { FormLayout } from '@steward/kernel';
import { stringifyEncodedQuery } from '@steward/shared';
import { useState } from 'react';
import { ListView } from './ListView';

/** Tabs of related records (incoming references, or configured `table.field[=parent_field]` entries). */
export function RelatedLists({ form, sysId }: { form: FormLayout; sysId: string }) {
  const [active, setActive] = useState(0);
  if (!form.relatedLists.length) return null;
  const current = form.relatedLists[Math.min(active, form.relatedLists.length - 1)]!;
  const parentValue = current.parentField === 'sys_id' ? sysId : form.record[current.parentField]?.value;
  const value = parentValue == null ? '' : String(parentValue);
  const fixed = stringifyEncodedQuery({ groups: [[[{ field: current.field, operator: value ? '=' : 'ISEMPTY', value }]]], orderBy: [] });
  const newQuery = value ? stringifyEncodedQuery({ groups: [[[{ field: current.field, operator: '=', value }]]], orderBy: [] }) : '';

  return (
    <section className="related-lists" aria-label="Related lists">
      <div className="tabs" role="tablist">
        {form.relatedLists.map((r, i) => (
          <button key={r.name} type="button" role="tab" aria-selected={r === current} className={r === current ? 'tab active' : 'tab'} onClick={() => setActive(i)}>
            {r.label}
          </button>
        ))}
      </div>
      {value ? (
        <ListView key={`${current.name}:${value}`} table={current.table} query="" offset={0} view="" embedded={{ fixedQuery: fixed, newQuery }} />
      ) : (
        <div className="muted">No related records ({current.parentField} is empty)</div>
      )}
    </section>
  );
}
