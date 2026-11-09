import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import type { Me } from '../context';
import { ErrorBanner } from './common';

export function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [userName, setUserName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data } = await api<{ user: Me }>('/api/steward/auth/login', {
        method: 'POST',
        body: { user_name: userName, password, session: 'cookie' },
      });
      onLogin(data.user);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit} aria-label="Log in">
        <h1>Steward</h1>
        <ErrorBanner error={error} />
        <label>
          User name
          <input name="user_name" autoComplete="username" value={userName} onChange={(e) => setUserName(e.target.value)} autoFocus />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button type="submit" className="primary" disabled={busy || !userName || !password}>
          Log in
        </button>
      </form>
    </div>
  );
}
