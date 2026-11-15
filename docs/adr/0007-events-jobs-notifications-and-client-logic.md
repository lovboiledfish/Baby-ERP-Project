# ADR 0007: Events, scheduled jobs, email notifications, and client form logic

Status: accepted (Phase 5)

## Context

Phase 5 adds four capabilities that turn static forms and synchronous server hooks into an active
workflow platform:
1. A transactional event outbox (`sys_event` + `gs.eventQueue`) and Script Actions (`sysevent_script_action`).
2. Scheduled jobs (`sys_trigger`) supporting `once`, `interval`, and 5-field `cron` schedules.
3. Email notifications (`sysevent_email_action`) and an outbound email log/queue (`sys_email`) with
   template variable substitution and user/group recipient resolution.
4. Client Scripts (`sys_script_client`: `onLoad`, `onChange`, `onSubmit` with `g_form`) and declarative
   UI Policies (`sys_ui_policy` + `sys_ui_policy_action`).

## Decision

1. **Transactional outbox (`sys_event` + `sys_email`).**
   - Calling `gs.eventQueue(name, record, parm1, parm2)` inside a Business Rule (or any script) inserts
     a `sys_event` row with `state = 'ready'` using the active `DataEngine` transaction. If the outer
     database write aborts or rolls back, the queued event rolls back with it — events are never emitted
     for uncommitted writes.
   - Similarly, record-triggered email notifications (`sysevent_email_action` with `when_to_send = 'record'`)
     are evaluated inside the write transaction after `after` rules and insert `sys_email` rows with
     `type = 'send-ready'` into the transactional outbox.
   - On outer transaction commit, `DataEngine` enqueues a post-commit drain task on `EventService`.
     `EventService.drain` atomically claims `ready` `sys_event` rows (`UPDATE ... WHERE state = 'ready' RETURNING sys_id`),
     executes matching `sysevent_script_action` scripts in `order` (with `event` and `current` bound in the
     V8 isolate), evaluates event-triggered `sysevent_email_action` rows (`when_to_send = 'event'`), and
     delivers `send-ready` `sys_email` rows through the configured `EmailTransport` (marking `type = 'sent'`
     or `'send-failed'`).
2. **Recipient resolution and `${...}` template rendering.**
   - Notifications resolve recipients from `recipient_fields` (reference fields on `current` pointing to
     `sys_user` or `sys_user_group`, expanding group email + active `sys_user_grmember` members),
     `recipient_users` (user `sys_id`s, `user_name`s, or literal email addresses), and `event_parm_1`
     (when `true`, resolves `event.parm1` as a user, group, or email address).
   - Subject and body templates interpolate `${field}`, dot-walked `${ref.field}` paths, `${event.*}`,
     and `${URI}` using display values.
3. **Scheduled jobs (`sys_trigger`) and deterministic worker ticks.**
   - `EventService.tick(engine, now)` claims due `sys_trigger` rows (`state = 'ready' AND next_action <= now`),
     executes their script in `ScriptRuntime`, increments `run_count`, records `last_run`, and advances
     `next_action` (`complete` for `once`, `now + repeat_seconds` for `interval`, or `nextCronDate` for
     5-field UTC `cron` expressions).
   - In production (`packages/server/src/main.ts`), `instance.events.startWorker(instance.engine)` runs
     periodic ticks; in tests and via `POST /api/steward/events/tick`, ticks can be driven deterministically
     with an explicit timestamp.
4. **Client Scripts (`g_form`) and UI Policies in `FormView`.**
   - `UiService.formLayout` returns active `clientScripts` (`sys_script_client`) and `uiPolicies`
     (`sys_ui_policy` + `sys_ui_policy_action`) inherited across the table's ancestor chain.
   - In the browser (`packages/web/src/lib/g-form.ts`), UI Policies evaluate their encoded-query
     `conditions` against live form values on load and on every field change, toggling `mandatory`,
     `visible`, `readOnly` (`disabled`), and `cleared` (and reversing when `reverse_if_false` is true).
   - Client scripts (`onLoad`, `onChange`, `onSubmit`) run against a `GlideForm` (`g_form`) facade that
     supports reading/mutating field values, toggling mandatory/visible/read-only state, displaying field
     and form messages, and aborting form submission when `onSubmit` returns `false`.
   - **Security invariant:** client-side UI policies and `g_form.setReadOnly(field, false)` never unlock a
     field that the server's `FormAccess` marked non-writable, and the server `DataEngine` still enforces
     all ACLs and dictionary constraints on save.

## Consequences

- Both ServiceNow notification patterns (`when_to_send = 'record'` and `gs.eventQueue` -> `when_to_send = 'event'`)
  work end-to-end and are atomic with database transactions.
- Outbound emails are stored as `sys_email` records and can be inspected in the UI (`/sys_email_list.do`),
  via `/api/steward/events/outbox`, or forwarded to Mailpit / a webhook via `STEWARD_EMAIL_WEBHOOK_URL`.
