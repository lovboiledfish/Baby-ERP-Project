import { UnauthorizedError, type Instance, type Session } from '@steward/kernel';
import type { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    stewardSession: Session | null;
    /** Bearer token used for this request (null for Basic auth). */
    stewardToken: string | null;
  }
}

export const WWW_AUTHENTICATE = 'Bearer realm="Steward", Basic realm="Steward"';

/**
 * Authenticate a request from its Authorization header:
 *   - Bearer <token>        token from POST /api/steward/auth/login
 *   - Basic base64(u:p)     user name + password (like ServiceNow's Table API)
 * Anything else is rejected with 401. There is no anonymous access.
 */
export function authenticate(instance: Instance) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization;
    if (!header) throw new UnauthorizedError();
    const space = header.indexOf(' ');
    const scheme = (space === -1 ? header : header.slice(0, space)).toLowerCase();
    const value = space === -1 ? '' : header.slice(space + 1).trim();
    if (scheme === 'bearer') {
      req.stewardSession = await instance.auth.resolveToken(value);
      req.stewardToken = value;
      return;
    }
    if (scheme === 'basic') {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon <= 0) throw new UnauthorizedError('Invalid credentials');
      req.stewardSession = await instance.auth.authenticate(decoded.slice(0, colon), decoded.slice(colon + 1));
      return;
    }
    throw new UnauthorizedError('Unsupported authorization scheme');
  };
}

/** The authenticated caller. Only valid on routes behind `authenticate`. */
export function sessionFor(req: FastifyRequest): Session {
  if (!req.stewardSession) throw new UnauthorizedError();
  return req.stewardSession;
}

export function bearerToken(req: FastifyRequest): string {
  if (!req.stewardToken) throw new UnauthorizedError('This endpoint requires a bearer token from /api/steward/auth/login');
  return req.stewardToken;
}
