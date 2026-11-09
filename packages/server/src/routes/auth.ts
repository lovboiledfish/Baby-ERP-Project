import { ValidationError, type Instance, type Session } from '@steward/kernel';
import type { FastifyPluginAsync } from 'fastify';
import { authenticate, bearerToken, clearSessionCookie, sessionCookie, sessionFor } from '../session';

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
    /**
     * Body: { user_name, password, session?: "cookie" }. With session=cookie (the web UI)
     * the token is set as an HttpOnly cookie and not returned in the body.
     */
    app.post('/login', async (req, reply) => {
      const { token, expires, session } = await instance.auth.login(stringField(req.body, 'user_name'), stringField(req.body, 'password'));
      const cookie = typeof req.body === 'object' && req.body !== null && (req.body as Record<string, unknown>).session === 'cookie';
      if (cookie) {
        reply.header('Set-Cookie', sessionCookie(req, token, expires));
        return { result: { token_type: 'Cookie', expires, user: describeSession(session) } };
      }
      return { result: { token, token_type: 'Bearer', expires, user: describeSession(session) } };
    });

    await app.register(async (secured) => {
      secured.addHook('preHandler', authenticate(instance));

      secured.get('/me', async (req) => ({ result: describeSession(sessionFor(req)) }));

      secured.post('/logout', async (req, reply) => {
        await instance.auth.logout(bearerToken(req));
        return reply.header('Set-Cookie', clearSessionCookie(req)).status(204).send();
      });

      secured.post('/impersonate', async (req) => {
        const session = await instance.auth.impersonate(bearerToken(req), stringField(req.body, 'user_name'));
        return { result: describeSession(session) };
      });

      secured.delete('/impersonate', async (req) => ({ result: describeSession(await instance.auth.endImpersonation(bearerToken(req))) }));
    });
  };
}
