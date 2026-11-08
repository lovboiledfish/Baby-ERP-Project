import { ValidationError, type Instance, type Session } from '@steward/kernel';
import type { FastifyPluginAsync } from 'fastify';
import { authenticate, bearerToken, sessionFor } from '../session';

function stringField(body: unknown, key: string): string {
  const v = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  if (typeof v !== 'string' || v === '') throw new ValidationError(`${key} is required`);
  return v;
}

export function describeSession(s: Session) {
  return {
    user_name: s.userName,
    sys_id: s.userId,
    roles: [...s.roles].sort(),
    groups: [...s.groups].sort(),
    impersonated_by: s.impersonator ? { user_name: s.impersonator.userName, sys_id: s.impersonator.userId } : null,
  };
}

/** /api/steward/auth: login, logout, whoami, impersonation. */
export function authRoutes(instance: Instance): FastifyPluginAsync {
  return async (app) => {
    app.post('/login', async (req) => {
      const { token, expires, session } = await instance.auth.login(stringField(req.body, 'user_name'), stringField(req.body, 'password'));
      return { result: { token, token_type: 'Bearer', expires, user: describeSession(session) } };
    });

    await app.register(async (secured) => {
      secured.addHook('preHandler', authenticate(instance));

      secured.get('/me', async (req) => ({ result: describeSession(sessionFor(req)) }));

      secured.post('/logout', async (req, reply) => {
        await instance.auth.logout(bearerToken(req));
        return reply.status(204).send();
      });

      secured.post('/impersonate', async (req) => {
        const session = await instance.auth.impersonate(bearerToken(req), stringField(req.body, 'user_name'));
        return { result: describeSession(session) };
      });

      secured.delete('/impersonate', async (req) => ({ result: describeSession(await instance.auth.endImpersonation(bearerToken(req))) }));
    });
  };
}
