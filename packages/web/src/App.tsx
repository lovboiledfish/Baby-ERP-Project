import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppContext, useApp as useAppSafe, type AppState, type Me, type NavTable } from './context';
import { api, errorMessage, UNAUTHORIZED_EVENT } from './lib/api';
import { useLocation } from './lib/hooks';
import { listUrl, parseRoute, resolveRoute, tableBuilderUrl } from './lib/routes';
import { ErrorBanner, Link, Spinner } from './components/common';
import { FormView } from './components/FormView';
import { ListView } from './components/ListView';
import { Login } from './components/Login';
import { Nav } from './components/Nav';
import { TableBuilder } from './components/TableBuilder';

type Auth = { state: 'loading' } | { state: 'anonymous' } | { state: 'ready'; me: Me };

/** The shell: login gate, header, navigator and the routed page. */
export function App() {
  const [auth, setAuth] = useState<Auth>({ state: 'loading' });
  const [tables, setTables] = useState<NavTable[]>([]);
  const [navError, setNavError] = useState<unknown>(null);
  const [navTick, setNavTick] = useState(0);
  const [meTick, setMeTick] = useState(0);
  const location = useLocation();

  useEffect(() => {
    let live = true;
    api<Me>('/api/steward/auth/me').then(
      ({ data }) => live && setAuth({ state: 'ready', me: data }),
      () => live && setAuth({ state: 'anonymous' }),
    );
    return () => {
      live = false;
    };
  }, [meTick]);

  useEffect(() => {
    const onUnauthorized = () => setAuth({ state: 'anonymous' });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const userKey = auth.state === 'ready' ? auth.me.user_name : '';
  useEffect(() => {
    if (!userKey) return;
    let live = true;
    api<{ tables: NavTable[] }>('/api/steward/ui/nav').then(
      ({ data }) => live && (setTables(data.tables), setNavError(null)),
      (e: unknown) => live && setNavError(e),
    );
    return () => {
      live = false;
    };
  }, [userKey, navTick]);

  const reloadNav = useCallback(() => setNavTick((t) => t + 1), []);
  const reloadMe = useCallback(() => setMeTick((t) => t + 1), []);

  const ctx = useMemo<AppState | null>(
    () => (auth.state === 'ready' ? { me: auth.me, isAdmin: auth.me.roles.includes('admin'), tables, reloadNav, reloadMe } : null),
    [auth, tables, reloadNav, reloadMe],
  );

  if (auth.state === 'loading') return <Spinner />;
  if (auth.state === 'anonymous' || !ctx) return <Login onLogin={(me) => (setAuth({ state: 'ready', me }), reloadNav())} />;

  const known = new Set(tables.map((t) => t.name));
  const route = resolveRoute(parseRoute(location.pathname, location.search), known);
  const key = location.pathname + location.search;

  let page;
  switch (route.kind) {
    case 'home':
      page = <Home />;
      break;
    case 'list':
      page = <ListView key={route.table + route.view} table={route.table} query={route.query} offset={route.offset} view={route.view} />;
      break;
    case 'form':
      page = <FormView key={key} table={route.table} sysId={route.sysId} query={route.query} view={route.view} />;
      break;
    case 'table_builder':
      page = <TableBuilder key={key} table={route.table} />;
      break;
    default:
      page = <div className="banner banner-error">Page not found: {route.path}</div>;
  }

  return (
    <AppContext.Provider value={ctx}>
      <div className="shell">
        <Header />
        <div className="body">
          <Nav />
          <main className="content">
            <ErrorBanner error={navError} />
            <div key={userKey}>{page}</div>
          </main>
        </div>
      </div>
    </AppContext.Provider>
  );
}

function Header() {
  const { me, isAdmin, reloadMe, reloadNav } = useAppSafe();
  const [error, setError] = useState<string | null>(null);

  const logout = async () => {
    try {
      await api('/api/steward/auth/logout', { method: 'POST' });
    } finally {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
  };
  const impersonate = async () => {
    const user = window.prompt('Impersonate which user (user name)?');
    if (!user) return;
    try {
      await api('/api/steward/auth/impersonate', { method: 'POST', body: { user_name: user } });
      setError(null);
      reloadMe();
      reloadNav();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const endImpersonation = async () => {
    try {
      await api('/api/steward/auth/impersonate', { method: 'DELETE' });
      reloadMe();
      reloadNav();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <header className="header">
      <Link href="/now/nav" className="brand">
        Steward
      </Link>
      {error && <span className="header-error">{error}</span>}
      <span className="spacer" />
      {me.impersonated_by && (
        <span className="impersonating">
          Impersonating <strong>{me.user_name}</strong> (as {me.impersonated_by.user_name}){' '}
          <button type="button" onClick={endImpersonation}>
            End
          </button>
        </span>
      )}
      {!me.impersonated_by && (isAdmin || me.roles.includes('impersonator')) && (
        <button type="button" onClick={impersonate}>
          Impersonate
        </button>
      )}
      <span className="user" data-testid="current-user">
        {me.user_name}
      </span>
      <button type="button" onClick={logout}>
        Log out
      </button>
    </header>
  );
}

function Home() {
  const { me, tables, isAdmin } = useAppSafe();
  const custom = tables.filter((t) => !t.name.startsWith('sys_'));
  return (
    <section className="home">
      <h2>Welcome, {me.user_name}</h2>
      <p className="muted">Every list and form here is generated from the dictionary, the UI layout records and your access controls.</p>
      {isAdmin && (
        <p>
          <Link className="button primary" href={tableBuilderUrl()}>
            Create a table
          </Link>
        </p>
      )}
      {custom.length > 0 && (
        <ul>
          {custom.map((t) => (
            <li key={t.name}>
              <Link href={listUrl(t.name)}>{t.label}</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
