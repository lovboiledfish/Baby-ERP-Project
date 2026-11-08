import type { Instance } from '@steward/kernel';
import type { FastifyPluginAsync } from 'fastify';
import { sessionFor } from '../session';

/** Metadata API: create tables/fields and inspect resolved schemas. */
export function metaRoutes(instance: Instance): FastifyPluginAsync {
  const { metaApi } = instance;

  return async (app) => {
    app.get('/tables', async () => ({ result: metaApi.list() }));

    app.post('/tables', async (req, reply) => {
      const table = await metaApi.createTable(req.body, sessionFor(req));
      return reply.status(201).send({ result: table });
    });

    app.get<{ Params: { table: string } }>('/tables/:table', async (req) => ({ result: metaApi.describe(req.params.table) }));

    app.post<{ Params: { table: string } }>('/tables/:table/fields', async (req, reply) => {
      const field = await metaApi.addField(req.params.table, req.body, sessionFor(req));
      return reply.status(201).send({ result: field });
    });
  };
}
