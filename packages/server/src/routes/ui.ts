import type { Instance } from '@steward/kernel';
import type { FastifyPluginAsync } from 'fastify';
import { authenticate, sessionFor } from '../session';
import { describeSession } from './auth';

type Query = Record<string, string | undefined>;

/**
 * /api/steward/ui: what the generated UI needs, derived from the dictionary,
 * the layout tables and the caller's ACLs. Record reads and writes go through
 * the regular Table API (/api/now/table).
 */
export function uiRoutes(instance: Instance): FastifyPluginAsync {
  const { ui, metaApi } = instance;
  return async (app) => {
    app.addHook('preHandler', authenticate(instance));

    /** Application navigator: every table the caller may read. */
    app.get('/nav', async (req) => {
      const session = sessionFor(req);
      return { result: { user: describeSession(session), tables: metaApi.list(session) } };
    });

    app.get<{ Params: { table: string }; Querystring: Query }>('/list/:table', async (req) => ({
      result: await ui.listLayout(req.params.table, req.query.sysparm_view, sessionFor(req)),
    }));

    /** Form for an existing record (?sys_id=...) or a new one (no sys_id, or sys_id=-1). */
    app.get<{ Params: { table: string }; Querystring: Query }>('/form/:table', async (req) => ({
      result: await ui.formLayout(req.params.table, req.query.sys_id ?? null, req.query.sysparm_view, sessionFor(req)),
    }));

    app.get<{ Params: { table: string; sys_id: string } }>('/activity/:table/:sys_id', async (req) => ({
      result: await ui.activity(req.params.table, req.params.sys_id, sessionFor(req)),
    }));
  };
}
