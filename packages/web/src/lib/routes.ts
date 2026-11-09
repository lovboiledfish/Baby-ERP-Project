/**
 * ServiceNow-style URLs:
 *   /now/nav                                   home + navigator
 *   /<table>_list.do?sysparm_query=...         list
 *   /<table>.do?sys_id=<id|-1>&sysparm_query=  form (-1 = new record, query = prefill)
 *   /now/table_builder[?table=<name>]          create a table / add fields
 *   /sys.scripts.do                            background scripts (admin)
 */
export type Route =
  | { kind: 'home' }
  | { kind: 'list'; table: string; query: string; offset: number; view: string }
  | { kind: 'form'; table: string; sysId: string; query: string; view: string }
  | { kind: 'table_builder'; table: string | null }
  | { kind: 'scripts' }
  | { kind: 'not_found'; path: string };

const TABLE = '[a-z][a-z0-9_]*';
const LIST_RE = new RegExp(`^/(${TABLE})_list\\.do$`);
const FORM_RE = new RegExp(`^/(${TABLE})\\.do$`);

export function parseRoute(pathname: string, search: string): Route {
  const params = new URLSearchParams(search);
  const view = params.get('sysparm_view') ?? '';
  if (pathname === '/' || pathname === '/now/nav' || pathname === '/now' || pathname === '/now/') return { kind: 'home' };
  if (pathname === '/now/table_builder') return { kind: 'table_builder', table: params.get('table') || null };
  if (pathname === '/sys.scripts.do' || pathname === '/now/scripts') return { kind: 'scripts' };
  const list = LIST_RE.exec(pathname);
  if (list) {
    const offset = Number(params.get('sysparm_offset') ?? 0);
    return { kind: 'list', table: list[1]!, query: params.get('sysparm_query') ?? '', offset: Number.isInteger(offset) && offset > 0 ? offset : 0, view };
  }
  const form = FORM_RE.exec(pathname);
  if (form) return { kind: 'form', table: form[1]!, sysId: params.get('sys_id') || '-1', query: params.get('sysparm_query') ?? '', view };
  return { kind: 'not_found', path: pathname };
}

/**
 * `/foo_list.do` is the list of `foo`, unless there is no table `foo` but there is
 * a table `foo_list` (then it is that table's form, like ServiceNow resolves it).
 */
export function resolveRoute(route: Route, tables: ReadonlySet<string>): Route {
  if (route.kind === 'list' && !tables.has(route.table) && tables.has(`${route.table}_list`)) {
    return { kind: 'form', table: `${route.table}_list`, sysId: '-1', query: '', view: route.view };
  }
  return route;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== 0) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function listUrl(table: string, opts: { query?: string; offset?: number; view?: string } = {}): string {
  return `/${table}_list.do${qs({ sysparm_query: opts.query, sysparm_offset: opts.offset, sysparm_view: opts.view })}`;
}

export function formUrl(table: string, sysId: string, opts: { query?: string; view?: string } = {}): string {
  return `/${table}.do${qs({ sys_id: sysId, sysparm_query: opts.query, sysparm_view: opts.view })}`;
}

export function tableBuilderUrl(table?: string): string {
  return `/now/table_builder${qs({ table })}`;
}

export function scriptsUrl(): string {
  return '/sys.scripts.do';
}

// ------------------------------------------------------------ navigation

const NAVIGATE_EVENT = 'steward:navigate';

export function navigate(url: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

export function onNavigate(listener: () => void): () => void {
  window.addEventListener('popstate', listener);
  window.addEventListener(NAVIGATE_EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(NAVIGATE_EVENT, listener);
  };
}
