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
    const isSys = (name: string) =>
      name.startsWith('sys_') ||
      name.startsWith('sysevent_') ||
      name === 'sysapproval_approver' ||
      name === 'contract_sla' ||
      name === 'task_sla';
    return { custom: visible.filter((t) => !isSys(t.name)), system: visible.filter((t) => isSys(t.name)) };
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
              <Link href={listUrl('sys_script_client')}>Client Scripts</Link>
            </li>
            <li>
              <Link href={listUrl('sys_ui_policy')}>UI Policies</Link>
            </li>
            <li>
              <Link href={listUrl('sysevent_email_action')}>Email Notifications</Link>
            </li>
            <li>
              <Link href={listUrl('sysevent_script_action')}>Script Actions</Link>
            </li>
            <li>
              <Link href={listUrl('sys_trigger')}>Scheduled Jobs</Link>
            </li>
            <li>
              <Link href={listUrl('sys_scope')}>Applications</Link>
            </li>
            <li>
              <Link href={listUrl('sys_update_set')}>Update Sets</Link>
            </li>
            <li>
              <Link href={listUrl('sys_hub_flow')}>Flows</Link>
            </li>
            <li>
              <Link href={listUrl('sys_flow_context')}>Flow Contexts</Link>
            </li>
            <li>
              <Link href={listUrl('sysapproval_approver')}>Approvals</Link>
            </li>
            <li>
              <Link href={listUrl('contract_sla')}>SLA Definitions</Link>
            </li>
            <li>
              <Link href={listUrl('task_sla')}>Task SLAs</Link>
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
