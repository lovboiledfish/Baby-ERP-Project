import { Instance, systemSession } from '@steward/kernel';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { parseCookies } from './session';

let inst: Instance;
let app: FastifyInstance;
let webRoot: string;
const ids: Record<string, string> = {};

const json = (res: { body: string }) => JSON.parse(res.body) as Record<string, any>;
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

async function cookieLogin(user: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/steward/auth/login', payload: { user_name: user, password, session: 'cookie' } });
  expect(res.statusCode).toBe(200);
  const setCookie = String(res.headers['set-cookie']);
  return setCookie.split(';')[0]!;
}

beforeAll(async () => {
  webRoot = mkdtempSync(path.join(tmpdir(), 'steward-web-'));
  writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><div id="root"></div>');
  mkdirSync(path.join(webRoot, 'assets'));
  writeFileSync(path.join(webRoot, 'assets', 'app-123.js'), 'console.log(1)');
  writeFileSync(path.join(webRoot, '..', `${path.basename(webRoot)}-secret.txt`), 'secret');

  inst = await Instance.create({ adminPassword: 'admin-pw' });
  app = await buildApp(inst, { webRoot });
  const sys = systemSession('setup');
  const insert = async (table: string, values: Record<string, unknown>) => String((await inst.engine.insert(table, values, sys)).sys_id);
  await inst.metaApi.createTable(
    { name: 'ticket', fields: [{ element: 'title', type: 'string', display: true }, { element: 'opened_by', type: 'reference', reference: 'sys_user' }, { element: 'work_notes', type: 'journal' }] },
    sys,
  );
  ids.carol = await insert('sys_user', { user_name: 'carol', first_name: 'Carol', user_password: 'carol-pw' });
  const acl = async (name: string, operation: string, condition: string | null) => insert('sys_security_acl', { name, operation, condition });
  await acl('ticket', 'read', 'opened_by=javascript:gs.getUserID()');
  await acl('ticket', 'create', null);
  await acl('ticket.work_notes', 'read', 'opened_by=NOBODY');
  ids.t1 = await insert('ticket', { title: 'Carol printer', opened_by: ids.carol, work_notes: 'hidden from carol' });
  ids.t2 = await insert('ticket', { title: 'Other' });
});

afterAll(async () => {
  await app.close();
  await inst.close();
  rmSync(webRoot, { recursive: true, force: true });
  rmSync(path.join(webRoot, '..', `${path.basename(webRoot)}-secret.txt`), { force: true });
});

describe('cookie sessions for the web UI', () => {
  it('sets an HttpOnly SameSite=Strict cookie and does not return the token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/steward/auth/login', payload: { user_name: 'carol', password: 'carol-pw', session: 'cookie' } });
    expect(res.statusCode).toBe(200);
    expect(json(res).result).not.toHaveProperty('token');
    expect(json(res).result.user.user_name).toBe('carol');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/^steward_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+/);
  });

  it('authenticates reads by cookie but requires the CSRF header on writes', async () => {
    const cookie = await cookieLogin('carol', 'carol-pw');
    const me = await app.inject({ url: '/api/steward/auth/me', headers: { cookie } });
    expect(json(me).result.user_name).toBe('carol');

    const noHeader = await app.inject({ method: 'POST', url: '/api/now/table/ticket', headers: { cookie }, payload: { title: 'x' } });
    expect(noHeader.statusCode).toBe(403);
    const withHeader = await app.inject({ method: 'POST', url: '/api/now/table/ticket', headers: { cookie, 'x-steward-csrf': '1' }, payload: { title: 'x', opened_by: ids.carol } });
    expect(withHeader.statusCode).toBe(201);
    // Header auth is unaffected by the CSRF rule.
    const basicPost = await app.inject({ method: 'POST', url: '/api/now/table/ticket', headers: { authorization: basic('carol', 'carol-pw') }, payload: { title: 'y' } });
    expect(basicPost.statusCode).toBe(201);
  });

  it('logout revokes the token and clears the cookie', async () => {
    const cookie = await cookieLogin('carol', 'carol-pw');
    const out = await app.inject({ method: 'POST', url: '/api/steward/auth/logout', headers: { cookie, 'x-steward-csrf': '1' } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/steward_session=; .*Max-Age=0/);
    expect((await app.inject({ url: '/api/steward/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('cookie sessions can impersonate (admin) like bearer sessions', async () => {
    const cookie = await cookieLogin('admin', 'admin-pw');
    const imp = await app.inject({ method: 'POST', url: '/api/steward/auth/impersonate', headers: { cookie, 'x-steward-csrf': '1' }, payload: { user_name: 'carol' } });
    expect(imp.statusCode).toBe(200);
    const list = await app.inject({ url: '/api/now/table/ticket', headers: { cookie } });
    expect(list.headers['x-total-count']).toBe('2');
  });

  it('parses cookie headers defensively', () => {
    expect(parseCookies('a=1; steward_session=abc%20d; a=2; bad; =x')).toEqual({ a: '1', steward_session: 'abc d' });
    expect(parseCookies('x=%E0%A4%A')).toEqual({ x: '%E0%A4%A' });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe('UI API', () => {
  const carol = () => ({ authorization: basic('carol', 'carol-pw') });

  it('requires authentication', async () => {
    for (const url of ['/api/steward/ui/nav', '/api/steward/ui/list/ticket', '/api/steward/ui/form/ticket', `/api/steward/ui/activity/ticket/${ids.t1}`]) {
      expect((await app.inject({ url })).statusCode).toBe(401);
    }
  });

  it('nav lists only readable tables', async () => {
    const res = json(await app.inject({ url: '/api/steward/ui/nav', headers: carol() })).result;
    const names = res.tables.map((t: { name: string }) => t.name);
    expect(names).toContain('ticket');
    expect(names).toContain('sys_user');
    expect(names).not.toContain('sys_audit');
    expect(res.user.user_name).toBe('carol');
  });

  it('list and form layouts', async () => {
    const list = json(await app.inject({ url: '/api/steward/ui/list/ticket', headers: carol() })).result;
    expect(list.columns.map((c: { path: string }) => c.path)).toEqual(['title', 'opened_by', 'sys_updated_on']);
    expect(list.canCreate).toBe(true);

    const form = json(await app.inject({ url: '/api/steward/ui/form/ticket', query: { sys_id: ids.t1 }, headers: carol() })).result;
    expect(form.record.title).toEqual({ value: 'Carol printer', display_value: 'Carol printer' });
    expect(form.access.canWrite).toBe(false);
    expect(form.sections[0].elements).toEqual(['title', 'opened_by']); // work_notes unreadable

    const blank = json(await app.inject({ url: '/api/steward/ui/form/ticket', headers: carol() })).result;
    expect(blank.isNew).toBe(true);
    expect(blank.access.fields.title.write).toBe(true);

    expect((await app.inject({ url: '/api/steward/ui/form/ticket', query: { sys_id: ids.t2 }, headers: carol() })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/steward/ui/list/sys_audit', headers: carol() })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/steward/ui/list/nope', headers: carol() })).statusCode).toBe(404);
  });

  it('activity respects record and field ACLs', async () => {
    const mine = json(await app.inject({ url: `/api/steward/ui/activity/ticket/${ids.t1}`, headers: carol() })).result as Array<{ field: string }>;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((e) => e.field === 'work_notes')).toBe(false);
    const admin = json(await app.inject({ url: `/api/steward/ui/activity/ticket/${ids.t1}`, headers: { authorization: basic('admin', 'admin-pw') } })).result as Array<{ field: string }>;
    expect(admin.some((e) => e.field === 'work_notes')).toBe(true);
    expect((await app.inject({ url: `/api/steward/ui/activity/ticket/${ids.t2}`, headers: carol() })).statusCode).toBe(404);
  });
});

describe('web UI hosting', () => {
  it('serves index.html for deep links with security headers', async () => {
    for (const url of ['/', '/now/nav', '/ticket_list.do?sysparm_query=active%3Dtrue', `/ticket.do?sys_id=${ids.t1}`]) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('<div id="root">');
      expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('serves fingerprinted assets with long caching', async () => {
    const res = await app.inject({ url: '/assets/app-123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toMatch(/immutable/);
    expect(res.body).toBe('console.log(1)');
  });

  it('never serves files outside the web root', async () => {
    const name = `${path.basename(webRoot)}-secret.txt`;
    for (const url of [`/../${name}`, `/..%2f${name}`, `/%2e%2e/${name}`, `/assets/..%5c..%5c${name}`, '/%00']) {
      const res = await app.inject({ url });
      expect(res.body).not.toBe('secret');
    }
  });

  it('keeps API 404s as JSON and does not fall back for non-GET requests', async () => {
    const api = await app.inject({ url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(json(api).status).toBe('failure');
    expect((await app.inject({ method: 'POST', url: '/ticket.do' })).statusCode).toBe(404);
  });
});
