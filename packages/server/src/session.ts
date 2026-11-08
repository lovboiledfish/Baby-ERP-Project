import type { Session } from '@steward/kernel';
import type { FastifyRequest } from 'fastify';

/** Phase 1 has no authentication: the caller may name themselves via X-Steward-User (defaults to admin). */
export function sessionFor(req: FastifyRequest): Session {
  const header = req.headers['x-steward-user'];
  const userName = typeof header === 'string' && header.trim() ? header.trim() : 'admin';
  return { userName };
}
