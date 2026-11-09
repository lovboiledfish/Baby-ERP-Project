import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { ErrorBanner } from './common';

interface ScriptLog {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
  timestamp: string;
}

interface ScriptMessage {
  type: 'info' | 'error';
  message: string;
}

interface EvalOutput {
  value: unknown;
  answer: unknown;
  logs: ScriptLog[];
  messages: ScriptMessage[];
  duration_ms: number;
}

const DEFAULT_SCRIPT = `const gr = new GlideRecord('sys_user');
gr.query();
gs.info('Users in instance: ' + gr.getRowCount());`;

/** Admin page (`/sys.scripts.do`): run server-side JavaScript in a V8 isolate (`isolated-vm`). */
export function BackgroundScripts() {
  const [script, setScript] = useState(DEFAULT_SCRIPT);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [output, setOutput] = useState<EvalOutput | null>(null);

  const onRun = async (e: FormEvent) => {
    e.preventDefault();
    if (!script.trim()) return;
    setRunning(true);
    setError(null);
    try {
      const { data } = await api<EvalOutput>('/api/steward/script/eval', {
        method: 'POST',
        body: { script },
      });
      setOutput(data);
    } catch (err) {
      setError(err);
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="form-page">
      <div className="toolbar">
        <h2>Scripts - Background</h2>
      </div>
      <p className="muted">
        Run server-side JavaScript inside a sandboxed V8 isolate with CPU and memory limits. Available globals:{' '}
        <code>GlideRecord</code>, <code>GlideRecordSecure</code>, <code>gs</code>, <code>GlideDateTime</code>,{' '}
        <code>Class</code>, and active Script Includes.
      </p>
      <ErrorBanner error={error} />
      <form onSubmit={onRun} className="form-body">
        <div className="field-row">
          <label htmlFor="bg_script">Script</label>
          <textarea
            id="bg_script"
            aria-label="Script"
            className="mono"
            rows={10}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            disabled={running}
          />
        </div>
        <div className="toolbar">
          <button type="submit" className="primary" disabled={running || !script.trim()}>
            {running ? 'Running…' : 'Run script'}
          </button>
        </div>
      </form>
      {output && (
        <div className="panel" data-testid="script-output">
          <h3>Output ({output.duration_ms} ms)</h3>
          {output.messages.map((m, i) => (
            <div key={i} className={`banner ${m.type === 'error' ? 'banner-error' : ''}`}>
              {m.message}
            </div>
          ))}
          {output.logs.length > 0 ? (
            <pre className="mono" data-testid="script-logs">
              {output.logs.map((l) => `[${l.level.toUpperCase()}] ${l.message}`).join('\n')}
            </pre>
          ) : (
            <div className="muted small">No log output</div>
          )}
          {output.value !== null && output.value !== undefined && (
            <div data-testid="script-return">
              <strong>Return value:</strong>{' '}
              <code>{typeof output.value === 'string' ? output.value : JSON.stringify(output.value)}</code>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
