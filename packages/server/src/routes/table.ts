import { NotFoundError, ValidationError, type DisplayMode, type Instance } from '@steward/kernel';
import type { FastifyPluginAsync } from 'fastify';
import { sessionFor } from '../session';

type Query = Record<string, string | undefined>;
interface TableParams {
  table: string;
}
interface RecordParams extends TableParams {
  sys_id: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function intParam(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ValidationError(`${name} must be a non-negative integer`);
  return n;
}

function displayMode(raw: string | undefined): DisplayMode {
  if (raw === 'true') return true;
  if (raw === 'all') return 'all';
  return false;
}

function fieldList(raw: string | undefined): string[] | undefined {
  const list = raw?.split(',').map((f) => f.trim()).filter(Boolean);
  return list?.length ? list : undefined;
}

function body(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError('Request body must be a JSON object');
  }
  return raw as Record<string, unknown>;
}

/** Parses If-Match: "3" / W/"3" / 3 into an expected sys_mod_count. */
function ifMatch(raw: string | string[] | undefined): number | undefined {
  if (raw === undefined || Array.isArray(raw)) return undefined;
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(raw.trim());
  if (!m) throw new ValidationError('If-Match must contain the record sys_mod_count, e.g. "3"');
  return Number(m[1]);
}

/** ServiceNow-compatible Table API: /api/now/table/{table}[/{sys_id}] */
export function tableRoutes(instance: Instance): FastifyPluginAsync {
  const { engine } = instance;

  return async (app) => {
    app.get<{ Params: TableParams; Querystring: Query }>('/:table', async (req, reply) => {
      const { table } = req.params;
      engine.meta.getTable(table);
      const q = req.query;
      const limit = Math.min(intParam(q.sysparm_limit, 'sysparm_limit', DEFAULT_LIMIT), MAX_LIMIT);
      const offset = intParam(q.sysparm_offset, 'sysparm_offset', 0);
      const rows = await engine.query(table, {
        query: q.sysparm_query,
        fields: fieldList(q.sysparm_fields),
        limit,
        offset,
        displayValue: displayMode(q.sysparm_display_value),
      });
      const total = await engine.count(table, q.sysparm_query);
      return reply.header('X-Total-Count', String(total)).send({ result: rows });
    });

    app.get<{ Params: RecordParams; Querystring: Query }>('/:table/:sys_id', async (req, reply) => {
      const { table, sys_id } = req.params;
      engine.meta.getTable(table);
      const record = await engine.get(table, sys_id, {
        fields: fieldList(req.query.sysparm_fields),
        displayValue: displayMode(req.query.sysparm_display_value),
      });
      if (!record) throw new NotFoundError('No Record found', `Record ${table}:${sys_id} doesn't exist or is not visible`);
      const raw = await engine.get(table, sys_id, { fields: ['sys_mod_count'] });
      return reply.header('ETag', `"${String(raw?.sys_mod_count ?? 0)}"`).send({ result: record });
    });

    app.post<{ Params: TableParams }>('/:table', async (req, reply) => {
      const record = await engine.insert(req.params.table, body(req.body), sessionFor(req));
      return reply
        .status(201)
        .header('Location', `/api/now/table/${req.params.table}/${String(record.sys_id)}`)
        .header('ETag', `"${String(record.sys_mod_count)}"`)
        .send({ result: record });
    });

    const update = async (req: { params: RecordParams; body: unknown; headers: Record<string, string | string[] | undefined> }, session: ReturnType<typeof sessionFor>) =>
      engine.update(req.params.table, req.params.sys_id, body(req.body), session, {
        expectedModCount: ifMatch(req.headers['if-match']),
      });

    app.patch<{ Params: RecordParams }>('/:table/:sys_id', async (req, reply) => {
      const record = await update(req, sessionFor(req));
      return reply.header('ETag', `"${String(record.sys_mod_count)}"`).send({ result: record });
    });

    app.put<{ Params: RecordParams }>('/:table/:sys_id', async (req, reply) => {
      const record = await update(req, sessionFor(req));
      return reply.header('ETag', `"${String(record.sys_mod_count)}"`).send({ result: record });
    });

    app.delete<{ Params: RecordParams }>('/:table/:sys_id', async (req, reply) => {
      await engine.delete(req.params.table, req.params.sys_id, sessionFor(req));
      return reply.status(204).send();
    });
  };
}
