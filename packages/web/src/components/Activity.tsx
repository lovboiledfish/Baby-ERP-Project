import type { ActivityEntry } from '@steward/kernel';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { ErrorBanner, Spinner } from './common';

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

/** Activity stream: journal entries (work notes, comments) and audited field changes, newest first. */
export function Activity({ table, sysId, reloadKey }: { table: string; sysId: string; reloadKey: number }) {
  const state = useAsync(() => api<ActivityEntry[]>(`/api/steward/ui/activity/${table}/${sysId}`).then((r) => r.data), [table, sysId, reloadKey]);
  return (
    <section className="activity" aria-label="Activity">
      <h3>Activity</h3>
      <ErrorBanner error={state.error} />
      {state.loading && !state.data && <Spinner />}
      {state.data?.length === 0 && <div className="muted">No activity yet</div>}
      <ul>
        {state.data?.map((e, i) => (
          <li key={i} className={`activity-entry ${e.type}`} data-testid="activity-entry">
            <div className="activity-meta">
              <strong>{e.created_by}</strong> <span className="muted">{when(e.created_on)}</span> <span className="tag">{e.label}</span>
            </div>
            {e.type === 'journal' ? (
              <div className="journal-value">{e.value}</div>
            ) : (
              <div className="audit-change">
                {e.old_display == null && e.old_value == null && e.new_display == null && e.new_value == null ? (
                  <em>changed</em>
                ) : (
                  <>
                    {e.old_display ?? e.old_value ?? <em>empty</em>} → {e.new_display ?? e.new_value ?? <em>empty</em>}
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
