import { ForbiddenError, ValidationError, type Instance } from '@steward/kernel';
import type { FastifyPluginAsync } from 'fastify';
import { authenticate, sessionFor } from '../session';

interface TickBody {
  now?: unknown;
}

/**
 * `/api/steward/events`: worker tick execution (scheduled jobs + event outbox + email delivery)
 * and outbound email inspection (admin only).
 */
export function eventRoutes(instance: Instance): FastifyPluginAsync {
  const { engine, events, acl } = instance;

  return async (app) => {
    app.addHook('preHandler', authenticate(instance));

    app.post<{ Body: TickBody }>('/tick', async (req) => {
      const session = sessionFor(req);
      if (!acl.isAdmin(session)) {
        throw new ForbiddenError('Only administrators can trigger the event/job worker');
      }
      const body = (req.body ?? {}) as TickBody;
      let now = new Date();
      if (body.now !== undefined && body.now !== null) {
        const parsed = new Date(String(body.now));
        if (Number.isNaN(parsed.getTime())) {
          throw new ValidationError('Invalid ISO timestamp for "now"');
        }
        now = parsed;
      }
      await instance.flush();
      const res = await events.tick(engine, now);
      return {
        result: {
          triggers_run: res.triggersRun,
          events_processed: res.eventsProcessed,
          emails_sent: res.emailsSent,
          sla_breaches: res.slaBreaches,
        },
      };
    });

    app.get('/outbox', async (req) => {
      const session = sessionFor(req);
      if (!acl.isAdmin(session)) {
        throw new ForbiddenError('Only administrators can inspect the event/email outbox');
      }
      await instance.flush();
      return {
        result: {
          sent_emails: events.sentEmails,
        },
      };
    });
  };
}
