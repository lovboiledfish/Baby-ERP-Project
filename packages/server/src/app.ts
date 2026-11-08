import { toStewardError, type Instance } from '@steward/kernel';
import Fastify, { type FastifyInstance } from 'fastify';
import { metaRoutes } from './routes/meta';
import { tableRoutes } from './routes/table';

export interface AppOptions {
  logger?: boolean;
}

export async function buildApp(instance: Instance, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  app.setErrorHandler((err: unknown, req, reply) => {
    const mapped = toStewardError(err);
    if (mapped) {
      return reply.status(mapped.status).send({ error: { message: mapped.message, detail: mapped.detail ?? null }, status: 'failure' });
    }
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply
        .status(statusCode)
        .send({ error: { message: (err as Error).message, detail: null }, status: 'failure' });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { message: 'Internal server error', detail: null }, status: 'failure' });
  });

  app.get('/health', async () => ({ status: 'ok', tables: instance.meta.listTables().length }));

  await app.register(tableRoutes(instance), { prefix: '/api/now/table' });
  await app.register(metaRoutes(instance), { prefix: '/api/steward/meta' });
  return app;
}
