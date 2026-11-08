import { Instance } from '@steward/kernel';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';

let inst: Instance;
let app: FastifyInstance;

const json = (res: { body: string }) => JSON.parse(res.body) as Record<string, any>;

beforeAll(async () => {
  inst = await Instance.create();
  app = await buildApp(inst);
});

afterAll(async () => {
  await app.close();
  await inst.close();
});

describe('Meta API', () => {
  it('creates tables, extends them and adds fields', async () => {
    const task = await app.inject({
      method: 'POST',
      url: '/api/steward/meta/tables',
      payload: {
        name: 'task',
        fields: [
          { element: 'number', type: 'string' },
          { element: 'short_description', type: 'string', maxLength: 160, mandatory: true },
          { element: 'priority', type: 'integer', defaultValue: 4 },
          { element: 'assigned_to', type: 'reference', reference: 'sys_user' },
        ],
      },
    });
    expect(task.statusCode).toBe(201);
    expect(json(task).result).toMatchObject({ name: 'task', label: 'Task', root: 'task' });

    const incident = await app.inject({
      method: 'POST',
      url: '/api/steward/meta/tables',
      payload: { name: 'incident', extends: 'task', numberPrefix: 'INC', fields: [{ element: 'caller', type: 'reference', reference: 'sys_user' }] },
    });
    expect(incident.statusCode).toBe(201);

    const field = await app.inject({
      method: 'POST',
      url: '/api/steward/meta/tables/incident/fields',
      payload: { element: 'impact', type: 'choice', defaultValue: '3', choices: [{ value: '1', label: 'High' }, { value: '2', label: 'Medium' }, { value: '3', label: 'Low' }] },
    });
    expect(field.statusCode).toBe(201);
    expect(json(field).result).toMatchObject({ element: 'impact', definedOn: 'incident', column: 'impact' });

    const described = json(await app.inject({ url: '/api/steward/meta/tables/incident' })).result;
    expect(described.fields.map((f: { element: string }) => f.element)).toEqual(
      expect.arrayContaining(['sys_id', 'number', 'short_description', 'priority', 'caller', 'impact']),
    );
    const listed = json(await app.inject({ url: '/api/steward/meta/tables' })).result;
    expect(listed).toEqual(expect.arrayContaining([{ name: 'incident', label: 'Incident', extends: 'task' }]));
  });

  it('rejects invalid definitions with a 400 and details', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/steward/meta/tables', payload: { name: 'Bad Name' } });
    expect(res.statusCode).toBe(400);
    expect(json(res)).toMatchObject({ status: 'failure', error: { message: 'Invalid metadata definition' } });
    expect(json(res).error.detail).toMatch(/name/);
  });
});

describe('Table API', () => {
  let sysId = '';
  let adminId = '';

  it('creates records (201, Location, ETag)', async () => {
    const [admin] = await inst.engine.query('sys_user', { query: 'user_name=admin', fields: ['sys_id'] });
    adminId = String(admin!.sys_id);
    const res = await app.inject({
      method: 'POST',
      url: '/api/now/table/incident',
      headers: { 'x-steward-user': 'alice' },
      payload: { short_description: 'Email is down', caller: adminId, impact: '1' },
    });
    expect(res.statusCode).toBe(201);
    const body = json(res).result;
    sysId = body.sys_id;
    expect(body).toMatchObject({ number: 'INC0001000', priority: 4, impact: '1', sys_created_by: 'alice', sys_class_name: 'incident' });
    expect(res.headers.location).toBe(`/api/now/table/incident/${sysId}`);
    expect(res.headers.etag).toBe('"0"');
  });

  it('lists with sysparm_query, sysparm_fields, paging and X-Total-Count', async () => {
    await app.inject({ method: 'POST', url: '/api/now/table/incident', payload: { short_description: 'VPN slow', priority: 2 } });
    await app.inject({ method: 'POST', url: '/api/now/table/task', payload: { short_description: 'Generic task' } });

    const res = await app.inject({
      url: '/api/now/table/task',
      query: { sysparm_query: 'ORDERBYDESCsys_created_on', sysparm_fields: 'number,sys_class_name', sysparm_limit: '2' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-total-count']).toBe('3');
    expect(json(res).result).toEqual([
      { number: null, sys_class_name: 'task' },
      { number: 'INC0001001', sys_class_name: 'incident' },
    ]);

    const page2 = json(await app.inject({ url: '/api/now/table/task', query: { sysparm_query: 'ORDERBYDESCsys_created_on', sysparm_fields: 'number', sysparm_limit: '2', sysparm_offset: '2' } }));
    expect(page2.result).toEqual([{ number: 'INC0001000' }]);
  });

  it('supports dot-walked fields and display values', async () => {
    const res = await app.inject({
      url: `/api/now/table/incident/${sysId}`,
      query: { sysparm_fields: 'number,caller,caller.user_name,impact', sysparm_display_value: 'true' },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).result).toEqual({ number: 'INC0001000', caller: 'System Administrator', 'caller.user_name': 'admin', impact: 'High' });

    const all = json(await app.inject({ url: `/api/now/table/incident/${sysId}`, query: { sysparm_fields: 'caller', sysparm_display_value: 'all' } }));
    expect(all.result).toEqual({ caller: { value: adminId, display_value: 'System Administrator' } });
  });

  it('updates with If-Match optimistic locking', async () => {
    const ok = await app.inject({ method: 'PATCH', url: `/api/now/table/incident/${sysId}`, headers: { 'if-match': '"0"' }, payload: { priority: 1 } });
    expect(ok.statusCode).toBe(200);
    expect(json(ok).result).toMatchObject({ priority: 1, sys_mod_count: 1 });
    expect(ok.headers.etag).toBe('"1"');

    const stale = await app.inject({ method: 'PUT', url: `/api/now/table/incident/${sysId}`, headers: { 'if-match': '"0"' }, payload: { priority: 2 } });
    expect(stale.statusCode).toBe(409);
    expect(json(stale).status).toBe('failure');
  });

  it('returns 400 for validation errors and bad queries', async () => {
    const missing = await app.inject({ method: 'POST', url: '/api/now/table/incident', payload: { priority: 1 } });
    expect(missing.statusCode).toBe(400);
    expect(json(missing).error.message).toMatch(/short_description/);

    const badQuery = await app.inject({ url: '/api/now/table/incident', query: { sysparm_query: 'Priority=1' } });
    expect(badQuery.statusCode).toBe(400);

    const badChoice = await app.inject({ method: 'PATCH', url: `/api/now/table/incident/${sysId}`, payload: { impact: '9' } });
    expect(badChoice.statusCode).toBe(400);

    const notObject = await app.inject({ method: 'POST', url: '/api/now/table/incident', payload: [1, 2] });
    expect(notObject.statusCode).toBe(400);
  });

  it('returns 404 for unknown tables and records', async () => {
    expect((await app.inject({ url: '/api/now/table/nope' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/now/table/incident/00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/now/table/incident/not-a-uuid' })).statusCode).toBe(404);
  });

  it('exposes the audit trail through the same API', async () => {
    const res = json(await app.inject({ url: '/api/now/table/sys_audit', query: { sysparm_query: `documentkey=${sysId}^fieldname=priority^ORDERBYrecord_checkpoint`, sysparm_fields: 'oldvalue,newvalue,record_checkpoint' } }));
    expect(res.result).toEqual([
      { oldvalue: null, newvalue: '4', record_checkpoint: 0 },
      { oldvalue: '4', newvalue: '1', record_checkpoint: 1 },
    ]);
  });

  it('deletes records (204 then 404)', async () => {
    expect((await app.inject({ method: 'DELETE', url: `/api/now/table/incident/${sysId}` })).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/now/table/incident/${sysId}` })).statusCode).toBe(404);
  });

  it('reports health', async () => {
    const res = json(await app.inject({ url: '/health' }));
    expect(res.status).toBe('ok');
    expect(res.tables).toBeGreaterThanOrEqual(9);
  });
});
