// @vitest-environment jsdom
/**
 * Full-stack UI test: the real React SPA rendered in jsdom, talking to the real
 * Fastify app + kernel (in-memory PGlite) through a fetch shim that keeps a
 * cookie jar like a browser. Covers the Phase 3 "done" criterion: an admin
 * defines a table in the UI and immediately uses its list and form.
 */
import { Instance, systemSession } from '@steward/kernel';
import { buildApp } from '@steward/server';
import type { FastifyInstance } from 'fastify';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App } from './App';
import { navigate } from './lib/routes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let inst: Instance;
let server: FastifyInstance;
let root: Root;
let container: HTMLDivElement;
const jar = new Map<string, string>();
const requests: Array<{ method: string; url: string; csrf: boolean }> = [];

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), window.location.href);
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const method = init.method ?? 'GET';
    requests.push({ method, url: url.pathname + url.search, csrf: 'X-Steward-CSRF' in headers });
    const res = await server.inject({ method: method as 'GET', url: url.pathname + url.search, headers, payload: init.body as string | undefined });
    const setCookie = res.headers['set-cookie'];
    for (const c of [setCookie ?? []].flat()) {
      const [pair] = String(c).split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq);
      if (/Max-Age=0/.test(String(c))) jar.delete(name);
      else jar.set(name, pair!.slice(eq + 1));
    }
    const out = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && k !== 'set-cookie') out.set(k, String(v));
    return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode, headers: out });
  }) as typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry an assertion until it passes (React renders + fetches are async). */
async function waitFor<T>(fn: () => T, timeout = 5000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeout) {
    try {
      return fn();
    } catch (e) {
      last = e;
    }
    await act(async () => {
      await sleep(20);
    });
  }
  throw last;
}

const $ = <E extends Element = HTMLElement>(sel: string) => {
  const el = container.querySelector<E>(sel);
  if (!el) throw new Error(`No element ${sel}`);
  return el;
};
const $$ = <E extends Element = HTMLElement>(sel: string) => [...container.querySelectorAll<E>(sel)];
const byLabel = <E extends Element = HTMLInputElement>(label: string) => $<E>(`[aria-label="${label}"]`);
const button = (text: string) => {
  const b = $$<HTMLButtonElement>('button, a.button').find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`No button "${text}" in: ${$$('button, a.button').map((x) => x.textContent?.trim()).join(' | ')}`);
  return b;
};
const text = () => container.textContent ?? '';

function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

async function type(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(async () => setValue(el, value));
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
}

async function go(url: string) {
  await act(async () => navigate(url));
}

async function login(user: string, password: string) {
  await waitFor(() => byLabel('Log in'));
  await type($('input[name="user_name"]'), user);
  await type($('input[name="password"]'), password);
  await click(button('Log in'));
  await waitFor(() => expect($('[data-testid="current-user"]').textContent).toBe(user));
}

beforeAll(async () => {
  inst = await Instance.create({ adminPassword: 'admin-pw' });
  server = await buildApp(inst);
  const sys = systemSession('setup');
  await inst.engine.insert('sys_user', { user_name: 'bob', first_name: 'Bob', user_password: 'bob-pw' }, sys);
  installFetch();
  window.history.replaceState(null, '', '/now/nav');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
});

afterAll(async () => {
  await act(async () => root.unmount());
  await server.close();
  await inst.close();
});

describe('generated UI, end to end', () => {
  let recordUrl = '';

  it('shows the login page first and logs in with a cookie session', async () => {
    await login('admin', 'admin-pw');
    expect(jar.has('steward_session')).toBe(true);
    expect(text()).toContain('Welcome, admin');
    expect(text()).toContain('System Definition');
  });

  it('lets an admin define a table in the UI', async () => {
    await go('/now/table_builder');
    await waitFor(() => byLabel('Field 1 column name'));
    await type($('#tb_name'), 'u_vehicle');
    await type($('#tb_label'), 'Vehicle');
    await type($('#tb_prefix'), 'veh');
    await type(byLabel('Field 1 column name'), 'model');
    await act(async () => byLabel('Field 1 mandatory').click());
    await act(async () => byLabel('Field 1 display').click());
    await click(button('Add field'));
    await type(byLabel('Field 2 column name'), 'status');
    await type(byLabel<HTMLSelectElement>('Field 2 type'), 'choice');
    await type(byLabel<HTMLTextAreaElement>('Field 2 choices'), 'new=New\nused=Used');
    await click(button('Add field'));
    await type(byLabel('Field 3 column name'), 'owner');
    await type(byLabel<HTMLSelectElement>('Field 3 type'), 'reference');
    await type(byLabel<HTMLSelectElement>('Field 3 reference'), 'sys_user');
    await click(button('Add field'));
    await type(byLabel('Field 4 column name'), 'work_notes');
    await type(byLabel<HTMLSelectElement>('Field 4 type'), 'journal');
    await click(button('Create'));

    await waitFor(() => expect(window.location.pathname).toBe('/u_vehicle_list.do'));
    await waitFor(() => expect($('[data-testid="list-count"]').textContent).toBe('No records'));
    // The navigator was refreshed with the new table.
    expect($$('nav a').map((a) => a.textContent)).toContain('Vehicle');
    // Default columns come straight from the dictionary.
    expect($$('th').map((th) => th.textContent)).toEqual(['Number', 'Model', 'Status', 'Owner', 'Updated']);
  });

  it('immediately uses the new form: mandatory check, reference picker, journal', async () => {
    await click(button('New'));
    await waitFor(() => expect($('[data-testid="form-title"]').textContent).toBe('New Vehicle'));
    const posts = requests.filter((r) => r.method === 'POST').length;
    await click(button('Submit'));
    await waitFor(() => expect($('[role="alert"]').textContent).toContain('Model is mandatory'));
    expect(requests.filter((r) => r.method === 'POST').length).toBe(posts); // nothing was sent

    await type(byLabel('Model'), 'Civic');
    await type(byLabel<HTMLSelectElement>('Status'), 'used');
    const owner = byLabel('Owner');
    await act(async () => owner.focus());
    await act(async () => owner.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    await type(owner, 'System');
    const option = await waitFor(() => {
      const o = $$('[role="option"]').find((x) => x.textContent === 'System Administrator');
      if (!o) throw new Error('no option yet');
      return o;
    });
    await act(async () => option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
    expect(owner.value).toBe('System Administrator');
    await type(byLabel<HTMLTextAreaElement>('Work Notes'), 'first note');
    await click(button('Submit'));

    await waitFor(() => expect(new URLSearchParams(window.location.search).get('sys_id')).toMatch(/^[0-9a-f-]{36}$/));
    recordUrl = window.location.pathname + window.location.search;
    await waitFor(() => expect($('[data-testid="form-title"]').textContent).toBe('Civic'));
    expect(byLabel('Number').value).toBe('VEH0001000');
    expect(byLabel('Number').disabled).toBe(true); // read-only dictionary field
    await waitFor(() => expect($$('[data-testid="activity-entry"]').some((e) => e.textContent?.includes('first note'))).toBe(true));
    expect(requests.filter((r) => r.method !== 'GET').every((r) => r.csrf)).toBe(true);
  });

  it('updates with optimistic locking and shows the change in the activity stream', async () => {
    await type(byLabel('Model'), 'Civic 2');
    await click(button('Update'));
    await waitFor(() => expect($('[role="status"]').textContent).toBe('Record updated'));
    await waitFor(() => expect($$('[data-testid="activity-entry"]').some((e) => /Civic\s*→\s*Civic 2/.test(e.textContent ?? ''))).toBe(true));
    const patch = requests.filter((r) => r.method === 'PATCH');
    expect(patch).toHaveLength(1);

    // A concurrent change makes the next save fail with a conflict instead of overwriting it.
    const sysId = new URLSearchParams(window.location.search).get('sys_id')!;
    await inst.engine.update('u_vehicle', sysId, { model: 'Changed elsewhere' }, systemSession('other'));
    await type(byLabel('Model'), 'Mine');
    await click(button('Update'));
    await waitFor(() => expect($('[role="alert"]').textContent).toMatch(/modified by someone else/));
  });

  it('lists the record with display values and filters with the condition builder', async () => {
    await go('/u_vehicle_list.do');
    await waitFor(() => expect($('[data-testid="list-count"]').textContent).toBe('1 to 1 of 1'));
    const row = $$('tbody tr')[0]!;
    expect(row.textContent).toContain('Changed elsewhere');
    expect(row.textContent).toContain('Used');
    expect(row.textContent).toContain('System Administrator');

    await click(button('Filter'));
    const fieldSel = await waitFor(() => byLabel<HTMLSelectElement>('Field'));
    await type(fieldSel, 'model');
    await type(byLabel<HTMLSelectElement>('Operator'), 'LIKE');
    await type(byLabel('Value for Model'), 'zzz');
    await click(button('Run'));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('sysparm_query')).toBe('modelLIKEzzz'));
    await waitFor(() => expect($('[data-testid="list-count"]').textContent).toBe('No records'));
    expect($('[aria-label="Filter breadcrumbs"]').textContent).toContain('Model contains zzz');

    await click($$<HTMLAnchorElement>('[aria-label="Filter breadcrumbs"] a').find((a) => a.textContent === 'All')!);
    await waitFor(() => expect($('[data-testid="list-count"]').textContent).toBe('1 to 1 of 1'));

    // Sorting by clicking a header puts ORDERBY in the URL.
    await click($$<HTMLButtonElement>('th button').find((b) => b.textContent === 'Model')!);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('sysparm_query')).toBe('ORDERBYmodel'));

    // Round-trip a URL query containing a dot-walked field, IN operator on a choice field, and reference equality.
    const admin = (await inst.engine.query('sys_user', { query: 'user_name=admin' }))[0]!;
    await go(`/u_vehicle_list.do?sysparm_query=${encodeURIComponent(`owner.user_name=admin^statusINused,new^owner=${String(admin.sys_id)}`)}`);
    await waitFor(() => expect($('[data-testid="list-count"]').textContent).toBe('1 to 1 of 1'));
    await click(button('Filter'));
    await waitFor(() => expect($$('[data-testid="cb-row"]')).toHaveLength(3));
    // Reference equality row resolves its display value from the referenced table.
    await waitFor(() => expect(byLabel('Value for Owner').value).toBe('System Administrator'));
    // Dot-walked field offers full string operators and preserves its condition on Run.
    await click(button('Run'));
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('sysparm_query')).toBe(`owner.user_name=admin^statusINused,new^owner=${String(admin.sys_id)}`),
    );
  });

  it('shows related lists on the referenced record', async () => {
    const admin = (await inst.engine.query('sys_user', { query: 'user_name=admin' }))[0]!;
    await go(`/sys_user.do?sys_id=${String(admin.sys_id)}`);
    const tab = await waitFor(() => {
      const t = $$('[role="tab"]').find((x) => x.textContent === 'Vehicle');
      if (!t) throw new Error('no Vehicle tab');
      return t;
    });
    await click(tab);
    await waitFor(() => expect($('[aria-label="Related lists"]').textContent).toContain('Changed elsewhere'));
  });

  it('lets an admin configure list columns and form sections (including custom views without overwriting default)', async () => {
    await go('/u_vehicle_list.do');
    await waitFor(() => button('Configure columns'));
    await click(button('Configure columns'));
    await waitFor(() => byLabel('Remove Updated'));
    await click(byLabel('Remove Updated'));
    await click(button('Save'));
    await waitFor(() => expect($$('th').map((th) => th.textContent)).toEqual(['Number', 'Model', 'Status', 'Owner']));

    // Configuring a custom view (falling back to default) creates a separate view layout instead of overwriting default.
    await go('/u_vehicle_list.do?sysparm_view=mobile');
    await waitFor(() => button('Configure columns'));
    await click(button('Configure columns'));
    await waitFor(() => byLabel('Remove Owner'));
    await click(byLabel('Remove Owner'));
    await click(button('Save'));
    await waitFor(() => expect($$('th').map((th) => th.textContent)).toEqual(['Number', 'Model', 'Status']));
    expect(await inst.engine.count('sys_ui_list', 'name=u_vehicle')).toBe(2);

    await go(recordUrl);
    await waitFor(() => button('Configure form'));
    await click(button('Configure form'));
    const caption = await waitFor(() => $<HTMLInputElement>('[aria-label="Configure form"] input'));
    await type(caption, 'Details');
    // An invalid section field rolls back the newly created sys_ui_form so fixing and re-saving succeeds.
    const fieldsArea = $<HTMLTextAreaElement>('[aria-label="Configure form"] textarea');
    const validElements = fieldsArea.value;
    await type(fieldsArea, 'model,no_such_field');
    await click(button('Save'));
    await waitFor(() => expect($('[aria-label="Configure form"] [role="alert"]').textContent).toMatch(/unknown fields/));
    await type(fieldsArea, validElements);
    await click(button('Save'));
    await waitFor(() => expect($('legend').textContent).toBe('Details'));
  });

  it('a user without write access gets a read-only form (field ACL decisions drive the UI)', async () => {
    const sys = systemSession('setup');
    const acl = await inst.engine.insert('sys_security_acl', { name: 'u_vehicle', operation: 'read' }, sys);
    expect(acl.sys_id).toBeTruthy();
    await click(button('Log out'));
    await login('bob', 'bob-pw');
    expect(text()).not.toContain('System Definition');
    await go(recordUrl);
    await waitFor(() => expect($('[data-testid="form-title"]').textContent).toBe('Changed elsewhere'));
    expect(byLabel('Model').disabled).toBe(true);
    expect(byLabel<HTMLSelectElement>('Status').disabled).toBe(true);
    expect($$('button').some((b) => b.textContent === 'Update')).toBe(false);
    expect(text()).toContain('Read only');
    // No "New" on the list without a create ACL.
    await go('/u_vehicle_list.do');
    await waitFor(() => expect($('[data-testid="list-count"]').textContent).toBe('1 to 1 of 1'));
    expect($$('a.button').some((b) => b.textContent === 'New')).toBe(false);
    // Unreadable tables show the server's 403.
    await go('/sys_audit_list.do');
    await waitFor(() => expect($('[role="alert"]').textContent).toMatch(/Not authorized to read sys_audit/));
  });

  it('returns to the login page when the session ends', async () => {
    await click(button('Log out'));
    await waitFor(() => byLabel('Log in'));
    expect(jar.has('steward_session')).toBe(false);
  });
});
