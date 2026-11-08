import { Instance, systemSession } from '@steward/kernel';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

let inst: Instance;
let app: FastifyInstance;
const ids: Record<string, string> = {};

const json = (res: { body: string }) => JSON.parse(res.body) as Record<string, any>;
const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const as = (authorization: string, opts: InjectOptions) => app.inject({ ...opts, headers: { ...(opts.headers ?? {}), authorization } });

async function login(user: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/steward/auth/login', payload: { user_name: user, password } });
  expect(res.statusCode).toBe(200);
  return `Bearer ${json(res).result.token}`;
}

beforeAll(async () => {
  inst = await Instance.create({ adminPassword: 'admin-pw' });
  app = await buildApp(inst);
  const sys = systemSession('setup');
  const insert = async (table: string, values: Record<string, unknown>) => String((await inst.engine.insert(table, values, sys)).sys_id);

  await inst.metaApi.createTable(
    {
      name: 'ticket',
      numberPrefix: 'TKT',
      fields: [
        { element: 'title', type: 'string', mandatory: true },
        { element: 'opened_by', type: 'reference', reference: 'sys_user' },
        { element: 'internal_notes', type: 'text' },
      ],
    },
    sys,
  );
  ids.agent = await insert('sys_user_role', { name: 'agent' });
  ids.alice = await insert('sys_user', { user_name: 'alice', first_name: 'Alice', user_password: 'alice-pw' });
  ids.carol = await insert('sys_user', { user_name: 'carol', first_name: 'Carol', user_password: 'carol-pw' });
  await insert('sys_user_has_role', { user: ids.alice, role: ids.agent });

  const acl = async (name: string, operation: string, condition: string | null, roles: string[]) => {
    const id = await insert('sys_security_acl', { name, operation, condition });
    for (const r of roles) await insert('sys_security_acl_role', { sys_security_acl: id, sys_user_role: r });
  };
  await acl('ticket', 'read', null, [ids.agent]);
  await acl('ticket', 'read', 'opened_by=javascript:gs.getUserID()', []);
  await acl('ticket', 'create', null, []);
  await acl('ticket.internal_notes', 'read', null, [ids.agent]);
  await acl('ticket.internal_notes', 'write', null, [ids.agent]);

  ids.t1 = await insert('ticket', { title: 'Carol printer', opened_by: ids.carol, internal_notes: 'carol is VIP' });
  ids.t2 = await insert('ticket', { title: 'Someone else', internal_notes: 'n/a' });
});

afterAll(async () => {
  await app.close();
  await inst.close();
});

describe('authentication', () => {
  it('requires credentials on every API (401 + WWW-Authenticate), but not on /health', async () => {
    for (const url of ['/api/now/table/ticket', '/api/steward/meta/tables', '/api/steward/auth/me']) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/Bearer/);
    }
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
  });

  it('no longer trusts the X-Steward-User header', async () => {
    const res = await app.inject({ url: '/api/now/table/ticket', headers: { 'x-steward-user': 'admin' } });
    expect(res.statusCode).toBe(401);
  });

  it('accepts Basic auth and rejects bad passwords / unknown schemes', async () => {
    expect((await as(basic('alice', 'alice-pw'), { url: '/api/now/table/ticket' })).statusCode).toBe(200);
    expect((await as(basic('alice', 'nope'), { url: '/api/now/table/ticket' })).statusCode).toBe(401);
    expect((await as('Digest abc', { url: '/api/now/table/ticket' })).statusCode).toBe(401);
    expect((await as('Bearer not-a-token', { url: '/api/now/table/ticket' })).statusCode).toBe(401);
  });

  it('logs in, reports the caller and logs out', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/steward/auth/login', payload: { user_name: 'alice', password: 'x' } });
    expect(bad.statusCode).toBe(401);
    const missing = await app.inject({ method: 'POST', url: '/api/steward/auth/login', payload: { user_name: 'alice' } });
    expect(missing.statusCode).toBe(400);

    const token = await login('alice', 'alice-pw');
    const me = json(await as(token, { url: '/api/steward/auth/me' })).result;
    expect(me).toMatchObject({ user_name: 'alice', sys_id: ids.alice, roles: ['agent'], impersonated_by: null });

    expect((await as(token, { method: 'POST', url: '/api/steward/auth/logout' })).statusCode).toBe(204);
    expect((await as(token, { url: '/api/steward/auth/me' })).statusCode).toBe(401);
  });
});

describe('Table API with ACLs: same request, different users', () => {
  const list = { url: '/api/now/table/ticket', query: { sysparm_fields: 'number,title,internal_notes', sysparm_query: 'ORDERBYnumber' } };

  it('returns different rows and fields per user', async () => {
    const alice = await as(basic('alice', 'alice-pw'), list);
    expect(alice.headers['x-total-count']).toBe('2');
    expect(json(alice).result).toEqual([
      { number: 'TKT0001000', title: 'Carol printer', internal_notes: 'carol is VIP' },
      { number: 'TKT0001001', title: 'Someone else', internal_notes: 'n/a' },
    ]);

    const carol = await as(basic('carol', 'carol-pw'), list);
    expect(carol.headers['x-total-count']).toBe('1');
    expect(json(carol).result).toEqual([{ number: 'TKT0001000', title: 'Carol printer' }]);
  });

  it('uses 404 for unreadable records, 403 for denied operations and unreadable tables', async () => {
    const carol = basic('carol', 'carol-pw');
    expect((await as(carol, { url: `/api/now/table/ticket/${ids.t2}` })).statusCode).toBe(404);
    expect((await as(carol, { url: `/api/now/table/ticket/${ids.t1}` })).statusCode).toBe(200);
    expect((await as(carol, { method: 'PATCH', url: `/api/now/table/ticket/${ids.t1}`, payload: { title: 'x' } })).statusCode).toBe(403);
    expect((await as(carol, { method: 'DELETE', url: `/api/now/table/ticket/${ids.t2}` })).statusCode).toBe(404);
    expect((await as(carol, { url: '/api/now/table/sys_audit' })).statusCode).toBe(403);
    expect((await as(carol, { url: '/api/now/table/ticket', query: { sysparm_query: 'internal_notesLIKEvip' } })).statusCode).toBe(403);
    expect((await as(carol, { url: '/api/steward/meta/tables/sys_audit' })).statusCode).toBe(403);
    expect((await as(carol, { method: 'POST', url: '/api/steward/meta/tables', payload: { name: 'u_x' } })).statusCode).toBe(403);
  });

  it('lets a user create a record they cannot read afterwards (minimal response)', async () => {
    const res = await as(basic('carol', 'carol-pw'), { method: 'POST', url: '/api/now/table/ticket', payload: { title: 'Anonymous tip' } });
    expect(res.statusCode).toBe(201);
    expect(Object.keys(json(res).result)).toEqual(['sys_id']);
    expect(res.headers.etag).toBeUndefined();
  });

  it('rejects setting a field the user may not write', async () => {
    const res = await as(basic('carol', 'carol-pw'), { method: 'POST', url: '/api/now/table/ticket', payload: { title: 't', internal_notes: 'x' } });
    expect(res.statusCode).toBe(403);
  });

  it('never exposes password hashes', async () => {
    const admin = await login('admin', 'admin-pw');
    const users = json(await as(admin, { url: '/api/now/table/sys_user' })).result as Array<Record<string, unknown>>;
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) expect(u).not.toHaveProperty('user_password');
    expect((await as(admin, { url: '/api/now/table/sys_user', query: { sysparm_fields: 'user_password' } })).statusCode).toBe(400);
  });
});

describe('impersonation over HTTP', () => {
  it('admin impersonates a user, sees what they see, then stops', async () => {
    const admin = await login('admin', 'admin-pw');
    const imp = await as(admin, { method: 'POST', url: '/api/steward/auth/impersonate', payload: { user_name: 'carol' } });
    expect(imp.statusCode).toBe(200);
    expect(json(imp).result).toMatchObject({ user_name: 'carol', impersonated_by: { user_name: 'admin' } });

    const seen = await as(admin, { url: '/api/now/table/ticket' });
    expect(seen.headers['x-total-count']).toBe('1');

    const end = await as(admin, { method: 'DELETE', url: '/api/steward/auth/impersonate' });
    expect(json(end).result.user_name).toBe('admin');
    expect(json(await as(admin, { url: '/api/steward/auth/me' })).result.impersonated_by).toBeNull();
  });

  it('requires a bearer session and the right role', async () => {
    expect((await as(basic('admin', 'admin-pw'), { method: 'POST', url: '/api/steward/auth/impersonate', payload: { user_name: 'carol' } })).statusCode).toBe(401);
    const alice = await login('alice', 'alice-pw');
    expect((await as(alice, { method: 'POST', url: '/api/steward/auth/impersonate', payload: { user_name: 'carol' } })).statusCode).toBe(403);
  });
});
