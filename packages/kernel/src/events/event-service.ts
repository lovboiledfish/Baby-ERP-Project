import { EncodedQueryError, parseEncodedQuery, type QueryAst } from '@steward/shared';
import type { DataEngine, RecordValues } from '../data/data-engine';
import type { Operation } from '../data/hooks';
import type { Db } from '../db/db';
import type { MetaService } from '../meta/meta-service';
import { matchesRecord } from '../script/match-record';
import { checkScriptSyntax, type ScriptEventBinding } from '../script/sandbox';
import type { ScriptService } from '../script/script-service';
import { SYSTEM_SESSION, type Session } from '../session';
import { isUuid } from '../util';
import { nextCronDate } from './cron';

export interface ScriptAction {
  sysId: string;
  name: string;
  eventName: string;
  order: number;
  conditionScript: string | null;
  script: string;
  broken: boolean;
}

export interface EmailNotification {
  sysId: string;
  name: string;
  collection: string;
  whenToSend: 'record' | 'event';
  actionInsert: boolean;
  actionUpdate: boolean;
  eventName: string | null;
  filterCondition: QueryAst | null;
  condition: string | null;
  recipientFields: string[];
  recipientUsers: string[];
  eventParm1: boolean;
  subject: string;
  messageText: string;
  broken: boolean;
}

export interface OutboundEmail {
  sysId: string;
  subject: string;
  recipients: string[];
  body: string;
  targetTable: string | null;
  instance: string | null;
  notification: string | null;
  sentOn: string;
}

export interface EmailTransport {
  send(email: OutboundEmail): Promise<void>;
}

export interface EventServiceOptions {
  /** Custom outbound email transport (e.g. Mailpit HTTP API or SMTP adapter). */
  emailTransport?: EmailTransport;
  /** Optional Mailpit / webhook URL (`POST` JSON `{ Subject, To, Text }`) for outbound email delivery. */
  emailWebhookUrl?: string;
}

export interface TickResult {
  triggersRun: number;
  eventsProcessed: number;
  emailsSent: number;
  slaBreaches: number;
}

interface ScriptActionRow {
  sys_id: string;
  name: string;
  event_name: string;
  order: number | null;
  condition_script: string | null;
  script: string | null;
}

interface NotificationRow {
  sys_id: string;
  name: string;
  collection: string;
  when_to_send: string | null;
  action_insert: boolean | null;
  action_update: boolean | null;
  event_name: string | null;
  filter_condition: string | null;
  condition: string | null;
  recipient_fields: string | null;
  recipient_users: string | null;
  event_parm_1: boolean | null;
  subject: string | null;
  message_text: string | null;
}

interface EventRow {
  sys_id: string;
  name: string;
  table: string | null;
  instance: string | null;
  parm1: string | null;
  parm2: string | null;
  claimed_by: string | null;
}

interface EmailRow {
  sys_id: string;
  subject: string | null;
  recipients: string;
  body: string | null;
  target_table: string | null;
  instance: string | null;
  notification: string | null;
}

interface TriggerRow {
  sys_id: string;
  name: string;
  trigger_type: string;
  repeat_seconds: number | null;
  cron_expression: string | null;
  next_action: unknown;
  run_count: number | null;
  script: string;
}

const MAX_SENT_BUFFER = 500;
const BATCH_LIMIT = 100;

/**
 * Create an HTTP webhook / Mailpit (`/api/v1/send`) transport for outbound emails.
 */
export function createWebhookEmailTransport(url: string): EmailTransport {
  return {
    async send(email) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          From: { Email: 'steward@localhost', Name: 'Steward Platform' },
          To: email.recipients.map((addr) => ({ Email: addr })),
          Subject: email.subject,
          Text: email.body,
          Meta: {
            sys_id: email.sysId,
            target_table: email.targetTable,
            instance: email.instance,
            notification: email.notification,
          },
        }),
      });
      if (!res.ok) {
        throw new Error(`Email webhook returned HTTP ${res.status}`);
      }
    },
  };
}

function splitList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n\r;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Manages the transactional event outbox (`sys_event`), Script Actions (`sysevent_script_action`),
 * Email Notifications (`sysevent_email_action` -> `sys_email`), and Scheduled Jobs (`sys_trigger`).
 */
export class EventService {
  private actionsByEvent = new Map<string, ScriptAction[]>();
  private notifications: EmailNotification[] = [];
  private transport: EmailTransport | null;
  private workerTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  readonly sentEmails: OutboundEmail[] = [];
  version = 0;

  constructor(
    private readonly meta: MetaService,
    private readonly scripts: ScriptService,
    opts: EventServiceOptions = {},
  ) {
    this.transport =
      opts.emailTransport ??
      (opts.emailWebhookUrl ? createWebhookEmailTransport(opts.emailWebhookUrl) : null);
  }

  setEmailTransport(transport: EmailTransport | null): void {
    this.transport = transport;
  }

  async load(db: Db): Promise<void> {
    const actionRows = await db.query<ScriptActionRow>(
      `SELECT "sys_id", "name", "event_name", "order", "condition_script", "script"
         FROM "sysevent_script_action"
        WHERE "active" IS NOT FALSE
        ORDER BY COALESCE("order", 100) ASC, "sys_created_on" ASC, "sys_id" ASC`,
    );
    const notifRows = await db.query<NotificationRow>(
      `SELECT "sys_id", "name", "collection", "when_to_send", "action_insert", "action_update",
              "event_name", "filter_condition", "condition", "recipient_fields", "recipient_users",
              "event_parm_1", "subject", "message_text"
         FROM "sysevent_email_action"
        WHERE "active" IS NOT FALSE
        ORDER BY "sys_created_on" ASC, "sys_id" ASC`,
    );

    const actionsByEvent = new Map<string, ScriptAction[]>();
    for (const r of actionRows.rows) {
      const script = r.script ?? '';
      let broken = !r.event_name?.trim() || !script.trim();
      const conditionScript = r.condition_script?.trim() ? r.condition_script.trim() : null;
      if (!broken && conditionScript) {
        try {
          checkScriptSyntax(conditionScript, { expression: true });
        } catch {
          broken = true;
        }
      }
      if (!broken) {
        try {
          checkScriptSyntax(script);
        } catch {
          broken = true;
        }
      }
      const action: ScriptAction = {
        sysId: r.sys_id,
        name: r.name,
        eventName: r.event_name,
        order: r.order ?? 100,
        conditionScript,
        script,
        broken,
      };
      actionsByEvent.set(action.eventName, [...(actionsByEvent.get(action.eventName) ?? []), action]);
    }

    const notifications: EmailNotification[] = [];
    for (const r of notifRows.rows) {
      const whenToSend = r.when_to_send === 'event' ? 'event' : 'record';
      let broken = !r.collection?.trim() || !r.subject?.trim();
      if (whenToSend === 'event' && !r.event_name?.trim()) broken = true;

      let filterCondition: QueryAst | null = null;
      if (r.filter_condition?.trim()) {
        try {
          filterCondition = parseEncodedQuery(r.filter_condition);
          if (filterCondition.groups.length === 0) filterCondition = null;
        } catch (e) {
          if (!(e instanceof EncodedQueryError)) throw e;
          broken = true;
        }
      }
      const condition = r.condition?.trim() ? r.condition.trim() : null;
      if (condition) {
        try {
          checkScriptSyntax(condition, { expression: true });
        } catch {
          broken = true;
        }
      }

      notifications.push({
        sysId: r.sys_id,
        name: r.name,
        collection: r.collection,
        whenToSend,
        actionInsert: Boolean(r.action_insert),
        actionUpdate: Boolean(r.action_update),
        eventName: r.event_name?.trim() || null,
        filterCondition,
        condition,
        recipientFields: splitList(r.recipient_fields),
        recipientUsers: splitList(r.recipient_users),
        eventParm1: Boolean(r.event_parm_1),
        subject: r.subject ?? '',
        messageText: r.message_text ?? '',
        broken,
      });
    }

    this.actionsByEvent = actionsByEvent;
    this.notifications = notifications;
    this.version++;
  }

  /**
   * Evaluate record-triggered (`when_to_send = 'record'`) email notifications inside
   * the active write transaction so `sys_email` rows are inserted atomically in the outbox.
   */
  async queueRecordNotifications(
    engine: DataEngine,
    operation: Operation,
    table: string,
    current: RecordValues,
    session: Session,
    previous?: RecordValues,
  ): Promise<number> {
    if (operation !== 'insert' && operation !== 'update') return 0;
    if (!this.meta.hasTable(table)) return 0;

    const ancestors = new Set(this.meta.ancestors(table).map((t) => t.name));
    const matching = this.notifications.filter(
      (n) =>
        !n.broken &&
        n.whenToSend === 'record' &&
        ancestors.has(n.collection) &&
        (operation === 'insert' ? n.actionInsert : n.actionUpdate),
    );
    if (!matching.length) return 0;

    let queued = 0;
    for (const notif of matching) {
      if (operation === 'update' && previous && !this.relevantRecordChange(notif, current, previous)) {
        continue;
      }
      if (!(await this.shouldSendNotification(engine, notif, table, operation, current, session, previous, undefined))) {
        continue;
      }
      if (await this.createEmailFromNotification(engine, notif, table, current, undefined)) {
        queued++;
      }
    }
    return queued;
  }

  /**
   * Build a post-commit task that drains queued `sys_event` rows and delivers `send-ready` `sys_email` rows.
   */
  buildDrainTask(): (rootEngine: DataEngine) => Promise<void> {
    return async (rootEngine: DataEngine) => {
      await this.drain(rootEngine);
    };
  }

  /** Schedule an asynchronous drain of pending events and emails in the background. */
  enqueueDrain(rootEngine: DataEngine): void {
    const p = Promise.resolve()
      .then(() => this.drain(rootEngine))
      .then(() => undefined)
      .finally(() => {
        this.inFlight.delete(p);
      });
    this.inFlight.add(p);
  }

  /**
   * Process all currently pending `sys_event` rows (including cascading events emitted
   * by Script Actions) and deliver all `send-ready` `sys_email` rows.
   */
  async drain(rootEngine: DataEngine): Promise<{ eventsProcessed: number; emailsSent: number }> {
    let eventsProcessed = 0;
    let emailsSent = 0;

    for (let pass = 0; pass < 8; pass++) {
      const evCount = await this.processReadyEvents(rootEngine);
      const emCount = await this.deliverReadyEmails(rootEngine);
      eventsProcessed += evCount;
      emailsSent += emCount;
      if (evCount === 0 && emCount === 0) break;
    }
    return { eventsProcessed, emailsSent };
  }

  /**
   * Run one worker cycle: execute all due `sys_trigger` scheduled jobs and evaluate
   * active SLA timers as of `now`, then drain all pending events and outbound emails.
   */
  async tick(rootEngine: DataEngine, now: Date = new Date()): Promise<TickResult> {
    const triggersRun = await this.runDueTriggers(rootEngine, now);
    const slaBreaches = rootEngine.slas ? await rootEngine.slas.evaluateBreaches(rootEngine, now) : 0;
    const { eventsProcessed, emailsSent } = await this.drain(rootEngine);
    return { triggersRun, eventsProcessed, emailsSent, slaBreaches };
  }

  /** Start a periodic background worker that runs `tick` every `intervalMs`. */
  startWorker(rootEngine: DataEngine, intervalMs = 1000): void {
    if (this.workerTimer) return;
    this.workerTimer = setInterval(() => {
      this.enqueueTick(rootEngine);
    }, intervalMs);
    this.workerTimer.unref?.();
  }

  stopWorker(): void {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
  }

  /** Wait for all in-flight async business rules, events, jobs, and email deliveries to complete. */
  async flush(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  async close(): Promise<void> {
    this.stopWorker();
    await this.flush();
  }

  private enqueueTick(rootEngine: DataEngine): void {
    const p = Promise.resolve()
      .then(() => this.tick(rootEngine))
      .then(() => undefined)
      .finally(() => {
        this.inFlight.delete(p);
      });
    this.inFlight.add(p);
  }

  private async processReadyEvents(rootEngine: DataEngine): Promise<number> {
    const res = await rootEngine.db.query<EventRow>(
      `SELECT "sys_id", "name", "table", "instance", "parm1", "parm2", "claimed_by"
         FROM "sys_event"
        WHERE "state" = 'ready'
        ORDER BY "sys_created_on" ASC, "sys_id" ASC
        LIMIT ${BATCH_LIMIT}`,
    );
    if (!res.rows.length) return 0;

    let processed = 0;
    for (const row of res.rows) {
      // Atomically claim the event so concurrent workers/drains never double-process it.
      const claim = await rootEngine.db.query<{ sys_id: string }>(
        `UPDATE "sys_event"
            SET "state" = 'processed', "processed" = now(), "sys_updated_on" = now()
          WHERE "sys_id" = $1 AND "state" = 'ready'
          RETURNING "sys_id"`,
        [row.sys_id],
      );
      if (!claim.rows.length) continue;

      processed++;
      const eventBinding: ScriptEventBinding = {
        sys_id: row.sys_id,
        name: row.name,
        table: row.table ?? null,
        instance: row.instance ?? null,
        parm1: row.parm1 ?? '',
        parm2: row.parm2 ?? '',
      };

      try {
        let targetRecord: RecordValues | null = null;
        let targetTable: string | null = null;
        if (row.table && row.instance && this.meta.hasTable(row.table) && isUuid(row.instance)) {
          targetRecord = await rootEngine.get(row.table, row.instance);
          if (targetRecord) {
            const actual = typeof targetRecord.sys_class_name === 'string' && this.meta.hasTable(targetRecord.sys_class_name)
              ? targetRecord.sys_class_name
              : row.table;
            targetTable = actual;
            if (actual !== row.table) {
              targetRecord = (await rootEngine.get(actual, row.instance)) ?? targetRecord;
            }
          }
        }

        // 1. Run matching Script Actions (`sysevent_script_action`).
        const actions = (this.actionsByEvent.get(row.name) ?? []).filter((a) => !a.broken);
        for (const action of actions) {
          if (action.conditionScript) {
            const condRes = await this.scripts.executeWithIncludes(rootEngine, {
              script: action.conditionScript,
              expression: true,
              sourceName: `sysevent_script_action/${action.name}.condition.js`,
              session: SYSTEM_SESSION,
              keepElevatedRoles: false,
              readOnly: true,
              current: targetRecord && targetTable ? { table: targetTable, values: targetRecord, readOnly: true } : undefined,
              event: eventBinding,
            });
            if (!condRes.value) continue;
          }

          await this.scripts.executeWithIncludes(rootEngine, {
            script: action.script,
            sourceName: `sysevent_script_action/${action.name}.js`,
            session: SYSTEM_SESSION,
            keepElevatedRoles: false,
            current: targetRecord && targetTable ? { table: targetTable, values: targetRecord, readOnly: false } : undefined,
            event: eventBinding,
          });
          // Reload targetRecord in case the Script Action updated it.
          if (targetTable && row.instance) {
            targetRecord = await rootEngine.get(targetTable, row.instance);
          }
        }

        // 2. Evaluate event-triggered Email Notifications (`when_to_send = 'event'`).
        const ancestors = targetTable && this.meta.hasTable(targetTable)
          ? new Set(this.meta.ancestors(targetTable).map((t) => t.name))
          : row.table
            ? new Set([row.table])
            : new Set<string>();

        const notifs = this.notifications.filter(
          (n) =>
            !n.broken &&
            n.whenToSend === 'event' &&
            n.eventName === row.name &&
            (ancestors.size === 0 || ancestors.has(n.collection)),
        );
        for (const notif of notifs) {
          const tbl = targetTable ?? notif.collection;
          const rec = targetRecord ?? {};
          if (!(await this.shouldSendNotification(rootEngine, notif, tbl, 'update', rec, SYSTEM_SESSION, undefined, eventBinding))) {
            continue;
          }
          await this.createEmailFromNotification(rootEngine, notif, tbl, rec, eventBinding);
        }

        // 3. Trigger any matching event-driven Flows (`sys_hub_flow`).
        if (rootEngine.flows) {
          await rootEngine.flows.onEvent(rootEngine, eventBinding, targetTable, targetRecord);
        }
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        await rootEngine.db.query(
          `UPDATE "sys_event" SET "state" = 'error', "error_message" = $1, "sys_updated_on" = now() WHERE "sys_id" = $2`,
          [msg, row.sys_id],
        );
        this.scripts.recordLog('error', `Event "${row.name}" (${row.sys_id}) failed: ${msg}`, `sys_event:${row.name}`);
      }
    }
    return processed;
  }

  private async deliverReadyEmails(rootEngine: DataEngine): Promise<number> {
    const res = await rootEngine.db.query<EmailRow>(
      `SELECT "sys_id", "subject", "recipients", "body", "target_table", "instance", "notification"
         FROM "sys_email"
        WHERE "type" = 'send-ready'
        ORDER BY "sys_created_on" ASC, "sys_id" ASC
        LIMIT ${BATCH_LIMIT}`,
    );
    if (!res.rows.length) return 0;

    let sent = 0;
    for (const row of res.rows) {
      const nowIso = new Date().toISOString();
      const claim = await rootEngine.db.query<{ sys_id: string }>(
        `UPDATE "sys_email"
            SET "type" = 'sent', "sent_on" = $1, "sys_updated_on" = $1
          WHERE "sys_id" = $2 AND "type" = 'send-ready'
          RETURNING "sys_id"`,
        [nowIso, row.sys_id],
      );
      if (!claim.rows.length) continue;

      const outbound: OutboundEmail = {
        sysId: row.sys_id,
        subject: row.subject ?? '',
        recipients: splitList(row.recipients),
        body: row.body ?? '',
        targetTable: row.target_table ?? null,
        instance: row.instance ?? null,
        notification: row.notification ?? null,
        sentOn: nowIso,
      };

      try {
        if (this.transport) {
          await this.transport.send(outbound);
        }
        if (this.sentEmails.length >= MAX_SENT_BUFFER) this.sentEmails.shift();
        this.sentEmails.push(outbound);
        sent++;
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        await rootEngine.db.query(
          `UPDATE "sys_email" SET "type" = 'send-failed', "error_message" = $1, "sys_updated_on" = now() WHERE "sys_id" = $2`,
          [msg, row.sys_id],
        );
        this.scripts.recordLog('error', `Email delivery (${row.sys_id}) failed: ${msg}`, 'sys_email');
      }
    }
    return sent;
  }

  private async runDueTriggers(rootEngine: DataEngine, now: Date): Promise<number> {
    const nowIso = now.toISOString();
    const res = await rootEngine.db.query<TriggerRow>(
      `SELECT "sys_id", "name", "trigger_type", "repeat_seconds", "cron_expression", "next_action", "run_count", "script"
         FROM "sys_trigger"
        WHERE "active" IS NOT FALSE
          AND ("state" = 'ready' OR "state" IS NULL)
          AND ("next_action" IS NULL OR "next_action" <= $1)
        ORDER BY COALESCE("next_action", '1970-01-01T00:00:00Z'::timestamptz) ASC, "sys_id" ASC
        LIMIT ${BATCH_LIMIT}`,
      [nowIso],
    );
    if (!res.rows.length) return 0;

    let count = 0;
    for (const row of res.rows) {
      const claim = await rootEngine.db.query<{ sys_id: string }>(
        `UPDATE "sys_trigger"
            SET "state" = 'running', "sys_updated_on" = $1
          WHERE "sys_id" = $2 AND ("state" = 'ready' OR "state" IS NULL)
          RETURNING "sys_id"`,
        [nowIso, row.sys_id],
      );
      if (!claim.rows.length) continue;

      count++;
      const runCount = (row.run_count ?? 0) + 1;
      try {
        await this.scripts.executeWithIncludes(rootEngine, {
          script: row.script,
          sourceName: `sys_trigger/${row.name}.js`,
          session: SYSTEM_SESSION,
          keepElevatedRoles: false,
        });

        if (row.trigger_type === 'once') {
          await rootEngine.db.query(
            `UPDATE "sys_trigger"
                SET "state" = 'complete', "active" = false, "last_run" = $1, "next_action" = NULL,
                    "run_count" = $2, "sys_updated_on" = $1
              WHERE "sys_id" = $3`,
            [nowIso, runCount, row.sys_id],
          );
        } else if (row.trigger_type === 'cron') {
          const next = nextCronDate(row.cron_expression ?? '* * * * *', now).toISOString();
          await rootEngine.db.query(
            `UPDATE "sys_trigger"
                SET "state" = 'ready', "last_run" = $1, "next_action" = $2,
                    "run_count" = $3, "sys_updated_on" = $1
              WHERE "sys_id" = $4`,
            [nowIso, next, runCount, row.sys_id],
          );
        } else {
          const secs = Math.max(1, row.repeat_seconds ?? 60);
          const next = new Date(now.getTime() + secs * 1000).toISOString();
          await rootEngine.db.query(
            `UPDATE "sys_trigger"
                SET "state" = 'ready', "last_run" = $1, "next_action" = $2,
                    "run_count" = $3, "sys_updated_on" = $1
              WHERE "sys_id" = $4`,
            [nowIso, next, runCount, row.sys_id],
          );
        }
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        await rootEngine.db.query(
          `UPDATE "sys_trigger"
              SET "state" = 'error', "last_run" = $1, "run_count" = $2, "sys_updated_on" = $1
            WHERE "sys_id" = $3`,
          [nowIso, runCount, row.sys_id],
        );
        this.scripts.recordLog('error', `Scheduled job "${row.name}" failed: ${msg}`, `sys_trigger:${row.name}`);
      }
    }
    return count;
  }

  private relevantRecordChange(notif: EmailNotification, current: RecordValues, previous: RecordValues): boolean {
    // If recipient_fields are specified and no filterCondition/condition is set, only send on update
    // when at least one recipient field changed (e.g. assigning an incident) or any non-system field changed.
    if (notif.recipientFields.length > 0 && !notif.filterCondition && !notif.condition) {
      return notif.recipientFields.some((f) => current[f] !== previous[f]);
    }
    const keys = new Set([...Object.keys(current), ...Object.keys(previous)]);
    for (const k of keys) {
      if (k.startsWith('sys_')) continue;
      if (current[k] !== previous[k]) return true;
    }
    return false;
  }

  private async shouldSendNotification(
    engine: DataEngine,
    notif: EmailNotification,
    table: string,
    operation: Operation,
    current: RecordValues,
    session: Session,
    previous?: RecordValues,
    event?: ScriptEventBinding,
  ): Promise<boolean> {
    if (notif.filterCondition && Object.keys(current).length > 0 && this.meta.hasTable(table)) {
      const matched = await matchesRecord(engine, table, current, notif.filterCondition, session);
      if (!matched) return false;
    }
    if (notif.condition) {
      const res = await this.scripts.executeWithIncludes(engine, {
        script: notif.condition,
        expression: true,
        sourceName: `sysevent_email_action/${notif.name}.condition.js`,
        session,
        keepElevatedRoles: false,
        readOnly: true,
        current:
          Object.keys(current).length > 0 && this.meta.hasTable(table)
            ? { table, values: current, isNew: operation === 'insert', operation, readOnly: true }
            : undefined,
        previous: previous && this.meta.hasTable(table) ? { table, values: previous } : undefined,
        event,
      });
      if (!res.value) return false;
    }
    return true;
  }

  private async createEmailFromNotification(
    engine: DataEngine,
    notif: EmailNotification,
    table: string,
    current: RecordValues,
    event?: ScriptEventBinding,
  ): Promise<boolean> {
    const recipients = await this.resolveRecipients(engine, notif, table, current, event);
    if (!recipients.length) return false;

    const subject = await this.renderTemplate(engine, notif.subject, table, current, event);
    const body = await this.renderTemplate(engine, notif.messageText, table, current, event);
    const instanceId = typeof current.sys_id === 'string' && isUuid(current.sys_id) ? current.sys_id : (event?.instance ?? null);

    await engine.insert(
      'sys_email',
      {
        subject,
        recipients: recipients.join(', '),
        body,
        type: 'send-ready',
        target_table: this.meta.hasTable(table) ? table : null,
        instance: instanceId,
        notification: notif.sysId,
      },
      SYSTEM_SESSION,
      { workflow: false },
    );
    return true;
  }

  private async resolveRecipients(
    engine: DataEngine,
    notif: EmailNotification,
    table: string,
    current: RecordValues,
    event?: ScriptEventBinding,
  ): Promise<string[]> {
    const emails = new Set<string>();
    const addEmail = (addr: unknown) => {
      if (typeof addr === 'string') {
        const trimmed = addr.trim();
        if (trimmed.includes('@')) emails.add(trimmed);
      }
    };

    const resolveTarget = async (token: string, refTableHint?: string) => {
      const t = token.trim();
      if (!t) return;
      if (t.includes('@')) {
        addEmail(t);
        return;
      }
      if (isUuid(t)) {
        if (!refTableHint || refTableHint === 'sys_user') {
          const user = await engine.get('sys_user', t);
          if (user && user.active !== false) {
            addEmail(user.email);
            return;
          }
        }
        if (!refTableHint || refTableHint === 'sys_user_group') {
          const group = await engine.get('sys_user_group', t);
          if (group && group.active !== false) {
            addEmail(group.email);
            const members = await engine.query('sys_user_grmember', {
              query: { groups: [[[{ field: 'group', operator: '=', value: t }]]], orderBy: [] },
              fields: ['user'],
            });
            for (const m of members) {
              if (typeof m.user === 'string' && isUuid(m.user)) {
                const u = await engine.get('sys_user', m.user);
                if (u && u.active !== false) addEmail(u.email);
              }
            }
          }
        }
        return;
      }
      // Look up user by `user_name` or group by `name`.
      const users = await engine.query('sys_user', {
        query: { groups: [[[{ field: 'user_name', operator: '=', value: t }]]], orderBy: [] },
        limit: 1,
      });
      if (users[0] && users[0].active !== false) {
        addEmail(users[0].email);
      }
    };

    if (this.meta.hasTable(table)) {
      const fields = this.meta.fields(table);
      for (const fieldName of notif.recipientFields) {
        const raw = current[fieldName];
        if (raw == null || raw === '') continue;
        const f = fields.get(fieldName);
        for (const item of String(raw).split(',')) {
          await resolveTarget(item, f?.reference ?? undefined);
        }
      }
    }

    for (const token of notif.recipientUsers) {
      await resolveTarget(token);
    }

    if (notif.eventParm1 && event?.parm1) {
      for (const item of event.parm1.split(',')) {
        await resolveTarget(item);
      }
    }

    return [...emails];
  }

  private async renderTemplate(
    engine: DataEngine,
    template: string,
    table: string,
    current: RecordValues,
    event?: ScriptEventBinding,
  ): Promise<string> {
    if (!template || !template.includes('${')) return template;

    const sysId = typeof current.sys_id === 'string' ? current.sys_id : (event?.instance ?? '');
    const tokens = [...new Set([...template.matchAll(/\$\{([a-zA-Z0-9_.]+)\}/g)].map((m) => m[1]!))];
    const values = new Map<string, string>();

    let displayRow: RecordValues | null = null;
    if (this.meta.hasTable(table) && sysId && isUuid(sysId)) {
      displayRow = await engine.get(table, sysId, { displayValue: 'all' });
    }

    for (const token of tokens) {
      if (token === 'URI') {
        values.set(token, sysId ? `/${table}.do?sys_id=${sysId}` : '');
        continue;
      }
      if (token.startsWith('event.')) {
        const prop = token.slice('event.'.length);
        const val =
          prop === 'name'
            ? event?.name
            : prop === 'parm1'
              ? event?.parm1
              : prop === 'parm2'
                ? event?.parm2
                : prop === 'table'
                  ? event?.table
                  : prop === 'instance'
                    ? event?.instance
                    : '';
        values.set(token, val ?? '');
        continue;
      }
      values.set(token, await this.resolveFieldDisplay(engine, table, current, displayRow, token));
    }

    return template.replace(/\$\{([a-zA-Z0-9_.]+)\}/g, (_, token: string) => values.get(token) ?? '');
  }

  private async resolveFieldDisplay(
    engine: DataEngine,
    table: string,
    current: RecordValues,
    displayRow: RecordValues | null,
    path: string,
  ): Promise<string> {
    if (!this.meta.hasTable(table)) {
      const v = current[path];
      return v == null ? '' : String(v);
    }
    const parts = path.split('.');
    if (parts.length === 1) {
      const el = parts[0]!;
      const cell = displayRow?.[el];
      if (cell && typeof cell === 'object' && 'display_value' in cell) {
        const dv = (cell as { display_value: string }).display_value;
        if (dv) return dv;
      }
      const raw = current[el];
      if (raw == null) return '';
      const f = this.meta.fields(table).get(el);
      if (f?.type === 'reference' && f.reference && typeof raw === 'string' && isUuid(raw) && this.meta.hasTable(f.reference)) {
        const refRow = await engine.get(f.reference, raw);
        const df = this.meta.displayField(f.reference).element;
        if (refRow && refRow[df] != null) return String(refRow[df]);
      }
      if (f?.type === 'choice') {
        return f.choices.find((c) => c.value === String(raw))?.label ?? String(raw);
      }
      return String(raw);
    }

    let curTable = table;
    let curRow: RecordValues | null = current;
    for (let i = 0; i < parts.length - 1; i++) {
      const hop = parts[i]!;
      const f = this.meta.fields(curTable).get(hop);
      if (!f || f.type !== 'reference' || !f.reference || !this.meta.hasTable(f.reference)) return '';
      const nextId = curRow?.[hop];
      if (typeof nextId !== 'string' || !isUuid(nextId)) return '';
      curRow = await engine.get(f.reference, nextId);
      curTable = f.reference;
      if (!curRow) return '';
    }
    const leaf = parts[parts.length - 1]!;
    return this.resolveFieldDisplay(engine, curTable, curRow ?? {}, null, leaf);
  }
}
