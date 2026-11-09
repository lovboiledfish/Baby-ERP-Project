import { toStewardError, type Instance } from '@steward/kernel';
import Fastify, { type FastifyInstance } from 'fastify';
import { authRoutes } from './routes/auth';
import { metaRoutes } from './routes/meta';
import { scriptRoutes } from './routes/script';
import { tableRoutes } from './routes/table';
import { uiRoutes } from './routes/ui';
import { WWW_AUTHENTICATE } from './session';
import { registerWebUi } from './web-ui';

export interface AppOptions {
  logger?: boolean;
  /** Directory of the built web UI (packages/web/dist). Omit to serve the API only. */
  webRoot?: string;
}

export async function buildApp(instance: Instance, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  app.decorateRequest('stewardSession', null);
  app.decorateRequest('stewardToken', null);

  app.setErrorHandler((err: unknown, req, reply) => {
    const mapped = toStewardError(err);
    if (mapped) {
      if (mapped.status === 401) reply.header('WWW-Authenticate', WWW_AUTHENTICATE);
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

  // Public: liveness only. Everything else requires authentication.
  app.get('/health', async () => ({ status: 'ok', tables: instance.meta.listTables().length }));

  await app.register(authRoutes(instance), { prefix: '/api/steward/auth' });
  await app.register(tableRoutes(instance), { prefix: '/api/now/table' });
  await app.register(metaRoutes(instance), { prefix: '/api/steward/meta' });
  await app.register(uiRoutes(instance), { prefix: '/api/steward/ui' });
  await app.register(scriptRoutes(instance), { prefix: '/api/steward/script' });
  if (opts.webRoot) registerWebUi(app, opts.webRoot);
  return app;
}
