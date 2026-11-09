import { ForbiddenError, ValidationError, type Instance } from '@steward/kernel';
import type { FastifyPluginAsync } from 'fastify';
import { authenticate, sessionFor } from '../session';

interface EvalBody {
  script?: unknown;
  timeout_ms?: unknown;
}

/**
 * `/api/steward/script`: ad-hoc background script execution (Scripts - Background)
 * and recent script log inspection (admin only).
 */
export function scriptRoutes(instance: Instance): FastifyPluginAsync {
  const { engine, scripts, acl } = instance;

  return async (app) => {
    app.addHook('preHandler', authenticate(instance));

    app.post<{ Body: EvalBody }>('/eval', async (req) => {
      const session = sessionFor(req);
      const body = (req.body ?? {}) as EvalBody;
      const script = typeof body.script === 'string' ? body.script : '';
      if (!script.trim()) throw new ValidationError('Script is required');

      let timeoutMs: number | undefined;
      if (body.timeout_ms !== undefined && body.timeout_ms !== null) {
        const n = Number(body.timeout_ms);
        if (!Number.isInteger(n) || n < 10 || n > 30_000) {
          throw new ValidationError('timeout_ms must be an integer between 10 and 30000');
        }
        timeoutMs = n;
      }

      const res = await scripts.evalBackground(engine, script, session, { timeoutMs });
      return {
        result: {
          value: res.value ?? null,
          answer: res.answer ?? null,
          logs: res.logs,
          messages: res.messages,
          duration_ms: res.durationMs,
        },
      };
    });

    app.get('/logs', async (req) => {
      const session = sessionFor(req);
      if (!acl.isAdmin(session)) throw new ForbiddenError('Only administrators can view script logs');
      return { result: scripts.recentLogs };
    });
  };
}
