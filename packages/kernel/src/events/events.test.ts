import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOOTSTRAP_VERSION, bootstrap, bootstrapVersion } from '../bootstrap/system-tables';
import { PgliteDb } from '../db/pglite';
import { ValidationError } from '../errors';
import { Instance } from '../instance';
import { SYSTEM_SESSION, systemSession } from '../session';
import { nextCronDate, parseCron } from './cron';
import type { OutboundEmail } from './event-service';

let inst: Instance;

beforeAll(async () => {
  inst = await Instance.create({
    adminPassword: 'admin-pw',
    script: { timeoutMs: 500, memoryLimitMb: 32, maxHostCalls: 250 },
  });
  const sys = systemSession('setup');
  await inst.metaApi.createTable(
    {
      name: 'task',
      label: 'Task',
      extendable: true,
      fields: [
        { element: 'short_description', type: 'string', mandatory: true, display: true },
        { element: 'priority', type: 'integer', defaultValue: 4 },
        {
          element: 'state',
          type: 'choice',
          defaultValue: 'new',
          choices: [
            { value: 'new', label: 'New' },
            { value: 'assigned', label: 'Assigned' },
            { value: 'closed', label: 'Closed' },
          ],
        },
        { element: 'assigned_to', type: 'reference', reference: 'sys_user' },
        { element: 'assignment_group', type: 'reference', reference: 'sys_user_group' },
      ],
    },
    sys,
  );
  await inst.metaApi.createTable(
    {
      name: 'incident',
      label: 'Incident',
      extends: 'task',
      numberPrefix: 'INC',
      fields: [{ element: 'escalation_notes', type: 'string' }],
    },
    sys,
  );
});

afterAll(async () => {
  await inst.close();
});

describe('cron expression parser and calculator', () => {
  it('parses 5-field cron expressions and calculates the next UTC run time', () => {
    const parsed = parseCron('*/15 9-17 * * 1-5');
    expect(parsed.minutes.has(0)).toBe(true);
    expect(parsed.minutes.has(15)).toBe(true);
    expect(parsed.minutes.has(10)).toBe(false);
    expect(parsed.hours.has(9)).toBe(true);
    expect(parsed.hours.has(18)).toBe(false);

    // 2026-11-16 is a Monday.
    const from = new Date('2026-11-16T09:03:25.000Z');
    expect(nextCronDate('*/15 9-17 * * 1-5', from).toISOString()).toBe('2026-11-16T09:15:00.000Z');

    // Friday after 17:45 rolls to Monday 09:00.
    const friEvening = new Date('2026-11-20T17:50:00.000Z');
    expect(nextCronDate('*/15 9-17 * * 1-5', friEvening).toISOString()).toBe('2026-11-23T09:00:00.000Z');
  });

  it('rejects malformed cron expressions', () => {
    expect(() => parseCron('* * * *')).toThrow(ValidationError);
    expect(() => parseCron('60 * * * *')).toThrow(ValidationError);
    expect(() => parseCron('*/0 * * * *')).toThrow(ValidationError);
    expect(() => parseCron('10-5 * * * *')).toThrow(ValidationError);
  });
});

describe('transactional event outbox (gs.eventQueue) and Script Actions', () => {
  it('rolls back queued sys_event rows if the outer transaction aborts, and runs Script Actions on commit', async () => {
    const sys = systemSession('admin');

    // Rule 1 (order 100): queues an event on insert.
    await inst.engine.insert(
      'sys_script',
      {
        name: 'Emit Incident Created',
        collection: 'incident',
        when: 'before',
        order: 100,
        action_insert: true,
        script: `gs.eventQueue('incident.created', current, current.short_description, 'from-rule');`,
      },
      sys,
    );

    // Rule 2 (order 200): aborts when short_description contains ABORT.
    await inst.engine.insert(
      'sys_script',
      {
        name: 'Abort Poison Incident',
        collection: 'incident',
        when: 'before',
        order: 200,
        action_insert: true,
        filter_condition: 'short_descriptionLIKEABORT',
        script: `
          gs.addErrorMessage('Blocked by rule');
          current.setAbortAction(true);
        `,
      },
      sys,
    );

    // Script Action: reacts to 'incident.created' by setting escalation_notes on the incident.
    await inst.engine.insert(
      'sysevent_script_action',
      {
        name: 'Stamp Escalation Notes',
        event_name: 'incident.created',
        order: 100,
        condition_script: `event.parm2 === 'from-rule'`,
        script: `
          current.escalation_notes = 'Event processed: ' + event.parm1;
          current.setWorkflow(false);
          current.update();
        `,
      },
      sys,
    );

    // 1. Aborted insert: the sys_event row queued by Rule 1 must roll back with the transaction!
    await expect(
      inst.engine.insert('incident', { short_description: 'Please ABORT this' }, sys),
    ).rejects.toThrow(/Blocked by rule/);
    await inst.flush();
    expect(await inst.engine.count('sys_event')).toBe(0);

    // 2. Committed insert: sys_event is committed and processed by the Script Action.
    const inc = await inst.engine.insert('incident', { short_description: 'Router down' }, sys);
    await inst.flush();

    const events = await inst.engine.query('sys_event', { query: 'name=incident.created' });
    expect(events).toHaveLength(1);
    expect(events[0]!.state).toBe('processed');
    expect(events[0]!.instance).toBe(inc.sys_id);

    const updated = await inst.engine.get('incident', String(inc.sys_id));
    expect(updated?.escalation_notes).toBe('Event processed: Router down');
  });
});

describe('Email Notifications (sysevent_email_action -> sys_email)', () => {
  it('sends an email when an incident is assigned (record-triggered) and via eventQueue (group expansion)', async () => {
    const sys = systemSession('admin');
    const delivered: OutboundEmail[] = [];
    inst.events.setEmailTransport({
      async send(email) {
        delivered.push(email);
      },
    });

    const bob = await inst.engine.insert(
      'sys_user',
      { user_name: 'bob', first_name: 'Bob', last_name: 'Builder', name: 'Bob Builder', email: 'bob@example.com' },
      sys,
    );
    const alice = await inst.engine.insert(
      'sys_user',
      { user_name: 'alice', first_name: 'Alice', last_name: 'Smith', name: 'Alice Smith', email: 'alice@example.com' },
      sys,
    );
    const netGroup = await inst.engine.insert(
      'sys_user_group',
      { name: 'Network', email: 'net-team@example.com' },
      sys,
    );
    await inst.engine.insert('sys_user_grmember', { group: netGroup.sys_id, user: alice.sys_id }, sys);

    // 1. Record-triggered notification on task hierarchy: assigning an incident emails the assignee.
    await inst.engine.insert(
      'sysevent_email_action',
      {
        name: 'Incident Assigned to User',
        collection: 'task',
        when_to_send: 'record',
        action_insert: true,
        action_update: true,
        filter_condition: 'assigned_toISNOTEMPTY',
        condition: `current.changes('assigned_to')`,
        recipient_fields: 'assigned_to',
        subject: '[${number}] Assigned to ${assigned_to.name}: ${short_description}',
        message_text: 'Hi ${assigned_to.first_name}, please check ${URI} (priority ${priority}).',
      },
      sys,
    );

    // 2. Event-triggered notification: 'incident.group_alert' emails the group in event.parm1.
    await inst.engine.insert(
      'sysevent_email_action',
      {
        name: 'Group Escalation Alert',
        collection: 'incident',
        when_to_send: 'event',
        event_name: 'incident.group_alert',
        event_parm_1: true,
        subject: '[Escalation ${number}] ${event.parm2}',
        message_text: 'Escalated ${short_description} to group.',
      },
      sys,
    );

    // Create an unassigned incident -> no email yet.
    const inc = await inst.engine.insert(
      'incident',
      { short_description: 'Core switch packet loss', priority: 1 },
      sys,
    );
    await inst.flush();
    expect(delivered).toHaveLength(0);

    // Assign the incident to Bob -> sends the assignment email!
    await inst.engine.update('incident', String(inc.sys_id), { assigned_to: bob.sys_id, state: 'assigned' }, sys);
    await inst.flush();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.recipients).toEqual(['bob@example.com']);
    expect(delivered[0]!.subject).toBe(`[${String(inc.number)}] Assigned to Bob Builder: Core switch packet loss`);
    expect(delivered[0]!.body).toBe(
      `Hi Bob, please check /incident.do?sys_id=${String(inc.sys_id)} (priority 1).`,
    );

    // Updating another field without changing `assigned_to` does NOT re-send the assignment email.
    await inst.engine.update('incident', String(inc.sys_id), { escalation_notes: 'Still investigating' }, sys);
    await inst.flush();
    expect(delivered).toHaveLength(1);

    // Fire 'incident.group_alert' with the Network group sys_id in parm1 -> expands group email + member Alice.
    await inst.scripts.evalBackground(
      inst.engine,
      `
        var gr = new GlideRecord('incident');
        gr.get('${String(inc.sys_id)}');
        gs.eventQueue('incident.group_alert', gr, '${String(netGroup.sys_id)}', 'Immediate P1 attention');
      `,
      SYSTEM_SESSION,
    );
    await inst.flush();

    expect(delivered).toHaveLength(2);
    expect(delivered[1]!.recipients).toEqual(['net-team@example.com', 'alice@example.com']);
    expect(delivered[1]!.subject).toBe(`[Escalation ${String(inc.number)}] Immediate P1 attention`);

    const emailRows = await inst.engine.query('sys_email', { query: 'ORDERBYsys_created_on' });
    expect(emailRows).toHaveLength(2);
    expect(emailRows.every((r) => r.type === 'sent')).toBe(true);
  });
});

describe('Scheduled Jobs (sys_trigger)', () => {
  it('executes once, interval, and cron scheduled jobs when due and advances next_action', async () => {
    const sys = systemSession('admin');

    const onceJob = await inst.engine.insert(
      'sys_trigger',
      {
        name: 'One-Time Property Seed',
        trigger_type: 'once',
        next_action: '2026-11-15T10:00:00.000Z',
        script: `gs.setProperty('job.once.ran', 'yes');`,
      },
      sys,
    );

    const intervalJob = await inst.engine.insert(
      'sys_trigger',
      {
        name: 'Heartbeat Counter',
        trigger_type: 'interval',
        repeat_seconds: 120,
        next_action: '2026-11-15T10:00:00.000Z',
        script: `
          var n = Number(gs.getProperty('job.heartbeat', '0')) + 1;
          gs.setProperty('job.heartbeat', String(n));
        `,
      },
      sys,
    );

    const cronJob = await inst.engine.insert(
      'sys_trigger',
      {
        name: 'Quarter-Hour Sweep',
        trigger_type: 'cron',
        cron_expression: '*/15 * * * *',
        next_action: '2026-11-15T10:00:00.000Z',
        script: `gs.setProperty('job.cron.ran', 'true');`,
      },
      sys,
    );

    // Tick 1 at 10:00:00Z -> all 3 jobs are due and run.
    const t1 = await inst.events.tick(inst.engine, new Date('2026-11-15T10:00:00.000Z'));
    expect(t1.triggersRun).toBe(3);

    const onceAfter = await inst.engine.get('sys_trigger', String(onceJob.sys_id));
    expect(onceAfter?.state).toBe('complete');
    expect(onceAfter?.active).toBe(false);
    expect(onceAfter?.run_count).toBe(1);

    const intervalAfter1 = await inst.engine.get('sys_trigger', String(intervalJob.sys_id));
    expect(intervalAfter1?.state).toBe('ready');
    expect(intervalAfter1?.run_count).toBe(1);
    expect(intervalAfter1?.next_action).toBe('2026-11-15T10:02:00.000Z');

    const cronAfter1 = await inst.engine.get('sys_trigger', String(cronJob.sys_id));
    expect(cronAfter1?.state).toBe('ready');
    expect(cronAfter1?.run_count).toBe(1);
    expect(cronAfter1?.next_action).toBe('2026-11-15T10:15:00.000Z');

    // Tick 2 at 10:01:00Z -> nothing is due yet.
    const t2 = await inst.events.tick(inst.engine, new Date('2026-11-15T10:01:00.000Z'));
    expect(t2.triggersRun).toBe(0);

    // Tick 3 at 10:02:00Z -> only the 120s interval job is due.
    const t3 = await inst.events.tick(inst.engine, new Date('2026-11-15T10:02:00.000Z'));
    expect(t3.triggersRun).toBe(1);

    const props = await inst.engine.query('sys_properties', { query: 'nameSTARTSWITHjob.' });
    const byName = new Map(props.map((p) => [String(p.name), String(p.value)]));
    expect(byName.get('job.once.ran')).toBe('yes');
    expect(byName.get('job.heartbeat')).toBe('2');
    expect(byName.get('job.cron.ran')).toBe('true');
  });
});

describe('Client Script & UI Policy metadata validation and FormLayout inclusion', () => {
  it('validates client scripts and UI policies on save and includes inherited ones in FormLayout', async () => {
    const sys = systemSession('admin');

    // Invalid onChange client script without field_name is rejected.
    await expect(
      inst.engine.insert(
        'sys_script_client',
        { name: 'Missing Field', table: 'task', type: 'onChange', script: 'function onChange() {}' },
        sys,
      ),
    ).rejects.toThrow(ValidationError);

    // Invalid JS syntax in client script is rejected.
    await expect(
      inst.engine.insert(
        'sys_script_client',
        { name: 'Broken Syntax', table: 'task', type: 'onLoad', script: 'function onLoad( {' },
        sys,
      ),
    ).rejects.toThrow(ValidationError);

    // Valid client script on parent `task` table:
    await inst.engine.insert(
      'sys_script_client',
      {
        name: 'Task Priority Change',
        table: 'task',
        type: 'onChange',
        field_name: 'priority',
        order: 50,
        script: `function onChange(control, oldValue, newValue) { if (newValue === '1') g_form.setMandatory('assigned_to', true); }`,
      },
      sys,
    );

    // Valid UI Policy + UI Policy Action on `incident`:
    const policy = await inst.engine.insert(
      'sys_ui_policy',
      {
        short_description: 'Require escalation notes on P1',
        table: 'incident',
        conditions: 'priority=1',
        on_load: true,
        reverse_if_false: true,
        order: 100,
      },
      sys,
    );
    await inst.engine.insert(
      'sys_ui_policy_action',
      {
        ui_policy: policy.sys_id,
        field: 'escalation_notes',
        mandatory: 'true',
        visible: 'true',
        disabled: 'false',
      },
      sys,
    );

    // Unknown field in sys_ui_policy_action is rejected:
    await expect(
      inst.engine.insert(
        'sys_ui_policy_action',
        { ui_policy: policy.sys_id, field: 'no_such_field', mandatory: 'true' },
        sys,
      ),
    ).rejects.toThrow(ValidationError);

    // FormLayout for `incident` includes both the inherited `task` client script and the `incident` UI policy.
    const layout = await inst.ui.formLayout('incident', null, 'default', sys);
    expect(layout.clientScripts).toHaveLength(1);
    expect(layout.clientScripts[0]!.name).toBe('Task Priority Change');
    expect(layout.clientScripts[0]!.fieldName).toBe('priority');

    expect(layout.uiPolicies).toHaveLength(1);
    expect(layout.uiPolicies[0]!.shortDescription).toBe('Require escalation notes on P1');
    expect(layout.uiPolicies[0]!.actions).toEqual([
      {
        field: 'escalation_notes',
        mandatory: 'true',
        visible: 'true',
        disabled: 'false',
        cleared: false,
      },
    ]);
  });
});

describe('bootstrap v5 upgrade', () => {
  it('adds Phase 5 tables to a Phase 4 (v4) instance in place', async () => {
    const db = await PgliteDb.open();
    await bootstrap(db);
    // Simulate a Phase 4 instance by dropping Phase 5 tables and resetting version to 4.
    for (const t of [
      'sys_ui_policy_action',
      'sys_ui_policy',
      'sys_script_client',
      'sys_email',
      'sysevent_email_action',
      'sys_trigger',
      'sysevent_script_action',
      'sys_event',
    ]) {
      await db.exec(`DROP TABLE "${t}"`);
      await db.query(`DELETE FROM "sys_db_object" WHERE "name" = $1`, [t]);
      await db.query(`DELETE FROM "sys_dictionary" WHERE "name" = $1`, [t]);
      await db.query(`DELETE FROM "sys_ui_list" WHERE "name" = $1`, [t]);
    }
    await db.query(`UPDATE "sys_properties" SET "value" = '4' WHERE "name" = 'glide.steward.bootstrap_version'`);
    expect(await bootstrapVersion(db)).toBe(4);

    const upgraded = await Instance.create({ db, adminPassword: 'pw' });
    expect(await bootstrapVersion(db)).toBe(BOOTSTRAP_VERSION);
    for (const t of [
      'sys_event',
      'sysevent_script_action',
      'sys_trigger',
      'sysevent_email_action',
      'sys_email',
      'sys_script_client',
      'sys_ui_policy',
      'sys_ui_policy_action',
    ]) {
      expect(upgraded.meta.hasTable(t)).toBe(true);
    }
    await upgraded.close();
  });
});
