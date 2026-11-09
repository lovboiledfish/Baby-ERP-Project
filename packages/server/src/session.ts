import { ForbiddenError, UnauthorizedError, type Instance, type Session } from '@steward/kernel';
import type { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    stewardSession: Session | null;
    /** Bearer/cookie token used for this request (null for Basic auth). */
    stewardToken: string | null;
  }
}

export const WWW_AUTHENTICATE = 'Bearer realm="Steward", Basic realm="Steward"';

/** HttpOnly session cookie used by the web UI (the token never reaches page scripts). */
export const SESSION_COOKIE = 'steward_session';
/**
 * Cookie-authenticated requests that can change state must carry this header.
 * Browsers only send custom headers cross-origin after a CORS preflight, which this
 * server never approves, so a forged cross-site form post or fetch cannot set it (CSRF).
 */
export const CSRF_HEADER = 'x-steward-csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export function sessionCookie(req: FastifyRequest, token: string, expires: string): string {
  const maxAge = Math.max(0, Math.floor((new Date(expires).getTime() - Date.now()) / 1000));
  const secure = req.protocol === 'https' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookie(req: FastifyRequest): string {
  const secure = req.protocol === 'https' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

/**
 * Authenticate a request:
 *   - Authorization: Bearer <token>   token from POST /api/steward/auth/login
 *   - Authorization: Basic base64(u:p) user name + password (like ServiceNow's Table API)
 *   - Cookie steward_session=<token>   the web UI; unsafe methods also need X-Steward-CSRF
 * Anything else is rejected with 401. There is no anonymous access.
 */
export function authenticate(instance: Instance) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization;
    if (!header) {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (!token) throw new UnauthorizedError();
      if (!SAFE_METHODS.has(req.method) && !req.headers[CSRF_HEADER]) {
        throw new ForbiddenError(`Cookie-authenticated ${req.method} requests need the ${CSRF_HEADER} header`);
      }
      req.stewardSession = await instance.auth.resolveToken(token);
      req.stewardToken = token;
      return;
    }
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
