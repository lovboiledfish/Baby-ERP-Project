import type { ListLayout, UiColumn } from '@steward/kernel';
import { useState } from 'react';
import { useApp } from '../context';
import { api } from '../lib/api';
import { andQueries, breadcrumbs, safeParse, withOrder } from '../lib/conditions';
import { useAsync } from '../lib/hooks';
import { formUrl, listUrl, navigate } from '../lib/routes';
import { ConditionBuilder } from './ConditionBuilder';
import { ErrorBanner, Link, Spinner } from './common';
import { ListConfig } from './ListConfig';

export const PAGE_SIZE = 20;

type Cell = { value: unknown; display_value: string };
type Row = Record<string, Cell>;

interface Props {
  table: string;
  query: string;
  offset: number;
  view: string;
  /** Related list mode: rows are restricted by `fixedQuery`; paging/sorting is local. */
  embedded?: { fixedQuery: string; newQuery: string };
}

/** A list generated from sys_ui_list (or the dictionary) with sorting, paging and the condition builder. */
export function ListView({ table, query, offset, view, embedded }: Props) {
  const { isAdmin } = useApp();
  const [localQuery, setLocalQuery] = useState('');
  const [localOffset, setLocalOffset] = useState(0);
  const [showFilter, setShowFilter] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const userQuery = embedded ? localQuery : query;
  const start = embedded ? localOffset : offset;

  const layout = useAsync(() => api<ListLayout>(`/api/steward/ui/list/${table}`, { query: { sysparm_view: view } }).then((r) => r.data), [table, view]);
  const columns = layout.data?.columns;
  const effective = embedded ? andQueries(embedded.fixedQuery, userQuery) : userQuery;
  const rows = useAsync(async () => {
    if (!columns) return null;
    const res = await api<Row[]>(`/api/now/table/${table}`, {
      query: {
        sysparm_query: effective,
        sysparm_fields: ['sys_id', ...columns.map((c) => c.path)].join(','),
        sysparm_display_value: 'all',
        sysparm_limit: PAGE_SIZE,
        sysparm_offset: start,
      },
    });
    return { rows: res.data, total: Number(res.headers.get('X-Total-Count') ?? res.data.length) };
  }, [table, effective, start, columns]);

  if (layout.error) return <ErrorBanner error={layout.error} />;
  if (!layout.data) return <Spinner />;
  const l = layout.data;

  const go = (q: string, off = 0) => {
    if (embedded) {
      setLocalQuery(q);
      setLocalOffset(off);
    } else navigate(listUrl(table, { query: q, offset: off, view }));
  };
  const sort = safeParse(userQuery).orderBy[0];
  const total = rows.data?.total ?? 0;
  const crumbs = embedded ? [] : breadcrumbs(userQuery, l.fields);

  const cell = (col: UiColumn, row: Row, first: boolean) => {
    const c = row[col.path];
    const text = c?.display_value ?? '';
    if (first) {
      return (
        <Link href={formUrl(table, String(row.sys_id?.value ?? ''), { view })} className="record-link">
          {text || '(empty)'}
        </Link>
      );
    }
    if (col.type === 'reference' && col.reference && typeof c?.value === 'string' && c.value) {
      return <Link href={formUrl(col.reference, c.value)}>{text || c.value}</Link>;
    }
    return text;
  };

  return (
    <section className={embedded ? 'list embedded' : 'list'} aria-label={`${l.table.label} list`}>
      <div className="toolbar">
        {!embedded && <h2>{l.table.label}</h2>}
        <button type="button" onClick={() => setShowFilter((s) => !s)} aria-expanded={showFilter}>
          Filter
        </button>
        {l.canCreate && (
          <Link className="button primary" href={formUrl(table, '-1', { query: embedded?.newQuery, view })}>
            New
          </Link>
        )}
        {isAdmin && !embedded && (
          <button type="button" onClick={() => setConfiguring(true)}>
            Configure columns
          </button>
        )}
        <span className="spacer" />
        <span className="muted small" data-testid="list-count">
          {total ? `${start + 1} to ${Math.min(start + PAGE_SIZE, total)} of ${total}` : 'No records'}
        </span>
        <button type="button" disabled={start === 0} onClick={() => go(userQuery, Math.max(0, start - PAGE_SIZE))} aria-label="Previous page">
          ‹
        </button>
        <button type="button" disabled={start + PAGE_SIZE >= total} onClick={() => go(userQuery, start + PAGE_SIZE)} aria-label="Next page">
          ›
        </button>
      </div>
      {!embedded && (
        <div className="breadcrumbs" aria-label="Filter breadcrumbs">
          <Link href={listUrl(table, { view })}>All</Link>
          {crumbs.map((c, i) => (
            <span key={i}>
              {' › '}
              <Link href={listUrl(table, { query: c.query, view })}>{c.label}</Link>
            </span>
          ))}
        </div>
      )}
      {showFilter && (
        <ConditionBuilder
          key={userQuery}
          fields={l.fields}
          query={userQuery}
          onRun={(q) => {
            setShowFilter(false);
            go(q);
          }}
        />
      )}
      {configuring && <ListConfig layout={l} onClose={(saved) => (setConfiguring(false), saved && layout.reload())} />}
      <ErrorBanner error={rows.error} />
      <table className="grid">
        <thead>
          <tr>
            {l.columns.map((col) => {
              const active = sort?.field === col.path;
              return (
                <th key={col.path} scope="col">
                  <button type="button" className="link" onClick={() => go(withOrder(userQuery, col.path, active ? !sort!.desc : false))}>
                    {col.label}
                    {active ? (sort!.desc ? ' ▼' : ' ▲') : ''}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.loading && !rows.data && (
            <tr>
              <td colSpan={l.columns.length}>
                <Spinner />
              </td>
            </tr>
          )}
          {rows.data?.rows.map((row) => (
            <tr key={String(row.sys_id?.value)}>
              {l.columns.map((col, i) => (
                <td key={col.path}>{cell(col, row, i === 0)}</td>
              ))}
            </tr>
          ))}
          {rows.data && rows.data.rows.length === 0 && (
            <tr>
              <td colSpan={l.columns.length} className="muted">
                No records to display
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
