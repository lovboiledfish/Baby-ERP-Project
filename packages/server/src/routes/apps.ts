import { ForbiddenError, type Instance, type UpdateSetBundle } from '@steward/kernel';
import type { FastifyPluginAsync } from 'fastify';
import { authenticate, sessionFor } from '../session';

/**
 * `/api/steward/apps`: Scoped application lifecycle (list, deploy, uninstall),
 * TypeScript `.d.ts` schema generation, and Update Set export/import.
 */
export function appRoutes(instance: Instance): FastifyPluginAsync {
  const { engine, apps, acl } = instance;

  return async (app) => {
    app.addHook('preHandler', authenticate(instance));

    app.get('/', async (req) => {
      const session = sessionFor(req);
      if (!acl.isAdmin(session)) {
        throw new ForbiddenError('Only administrators can list application packages');
      }
      return { result: apps.listApps() };
    });

    app.post('/deploy', async (req) => {
      const session = sessionFor(req);
      const res = await apps.deployPackage(engine, req.body, session);
      await instance.flush();
      return { result: res };
    });

    app.delete<{ Params: { scope: string } }>('/:scope', async (req) => {
      const session = sessionFor(req);
      const res = await apps.uninstallApp(engine, req.params.scope, session);
      await instance.flush();
      return { result: res };
    });

    app.get<{ Querystring: { scope?: string } }>('/types', async (req, reply) => {
      const session = sessionFor(req);
      if (!acl.isAdmin(session)) {
        throw new ForbiddenError('Only administrators can generate TypeScript definitions');
      }
      const dts = apps.generateTypes(req.query.scope);
      return reply.type('text/plain; charset=utf-8').send(dts);
    });

    app.get<{ Params: { sys_id: string } }>('/update-sets/:sys_id/export', async (req) => {
      const session = sessionFor(req);
      const bundle = await apps.exportUpdateSet(engine, req.params.sys_id, session);
      return { result: bundle };
    });

    app.post<{ Body: UpdateSetBundle }>('/update-sets/import', async (req) => {
      const session = sessionFor(req);
      const res = await apps.applyUpdateSet(engine, req.body, session);
      await instance.flush();
      return { result: res };
    });
  };
}
