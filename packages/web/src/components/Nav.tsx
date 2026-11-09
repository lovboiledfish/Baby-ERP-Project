import { useMemo, useState } from 'react';
import { useApp } from '../context';
import { formUrl, listUrl, scriptsUrl, tableBuilderUrl } from '../lib/routes';
import { Link } from './common';

/** Application navigator: every table the user may read, filterable. */
export function Nav() {
  const { tables, isAdmin } = useApp();
  const [filter, setFilter] = useState('');
  const { custom, system } = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const visible = tables.filter((t) => !f || t.name.includes(f) || t.label.toLowerCase().includes(f));
    return { custom: visible.filter((t) => !t.name.startsWith('sys_')), system: visible.filter((t) => t.name.startsWith('sys_')) };
  }, [tables, filter]);

  const item = (t: { name: string; label: string }) => (
    <li key={t.name}>
      <Link href={listUrl(t.name)} title={t.name}>
        {t.label}
      </Link>
    </li>
  );

  return (
    <nav className="nav" aria-label="Application navigator">
      <input className="nav-filter" placeholder="Filter navigator" aria-label="Filter navigator" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {isAdmin && (
        <div className="nav-section">
          <h3>System Definition</h3>
          <ul>
            <li>
              <Link href={tableBuilderUrl()}>Create table</Link>
            </li>
            <li>
              <Link href={listUrl('sys_db_object')}>Tables</Link>
            </li>
            <li>
              <Link href={formUrl('sys_db_object', '-1')}>New table record</Link>
            </li>
            <li>
              <Link href={listUrl('sys_script')}>Business Rules</Link>
            </li>
            <li>
              <Link href={listUrl('sys_script_include')}>Script Includes</Link>
            </li>
            <li>
              <Link href={scriptsUrl()}>Scripts - Background</Link>
            </li>
          </ul>
        </div>
      )}
      <div className="nav-section">
        <h3>Tables</h3>
        {custom.length ? <ul>{custom.map(item)}</ul> : <div className="muted small">No tables</div>}
      </div>
      {system.length > 0 && (
        <div className="nav-section">
          <h3>System</h3>
          <ul>{system.map(item)}</ul>
        </div>
      )}
    </nav>
  );
}
