import { describe, expect, it } from 'vitest';
import { itsmApp } from '../../../../apps/itsm/src/index';
import { PgliteDb } from '../db/pglite';
import { Instance } from '../instance';
import { SYSTEM_SESSION } from '../session';

describe('Phase 7: Durable Flows, Approvals & SLA Engine', () => {
  it('runs "P1 ticket -> approval -> notify" end-to-end and survives a worker restart while waiting for approval', async () => {
    const db = await PgliteDb.open();
    try {
      // Boot worker instance #1
      const inst1 = await Instance.create({ db });
      await inst1.apps.deployPackage(inst1.engine, itsmApp, SYSTEM_SESSION);

      const caller = await inst1.engine.insert(
        'sys_user',
        { user_name: 'alice', first_name: 'Alice', last_name: 'Caller', email: 'alice@example.com', active: true },
        SYSTEM_SESSION,
      );
      const manager = await inst1.engine.insert(
        'sys_user',
        { user_name: 'bob', first_name: 'Bob', last_name: 'Manager', email: 'bob@example.com', active: true },
        SYSTEM_SESSION,
      );

      // Create a P1 ticket -> triggers "P1 Ticket Approval and Notify" flow
      const ticket = await inst1.engine.insert(
        'x_steward_itsm_ticket',
        {
          short_description: 'Production DB primary failover',
          priority: '1',
          state: 'new',
          caller_id: caller.sys_id,
          approver: manager.sys_id,
        },
        SYSTEM_SESSION,
      );
      await inst1.flush();

      // Verify flow context is paused in `waiting` state at step 0 (`ask_for_approval`)
      const contexts = await inst1.engine.query('sys_flow_context', {
        query: `trigger_record=${String(ticket.sys_id)}`,
      });
      expect(contexts.length).toBe(1);
      const contextId = String(contexts[0]!.sys_id);
      expect(contexts[0]!.state).toBe('waiting');
      expect(contexts[0]!.current_step).toBe(0);

      // Verify sysapproval_approver row was created in `requested` state
      const approvals = await inst1.engine.query('sysapproval_approver', {
        query: `flow_context=${contextId}`,
      });
      expect(approvals.length).toBe(1);
      const approvalId = String(approvals[0]!.sys_id);
      expect(approvals[0]!.state).toBe('requested');
      expect(approvals[0]!.approver).toBe(manager.sys_id);

      // Shut down worker #1's in-memory services (without closing the underlying PGlite DB)
      await inst1.scripts.close();
      await inst1.events.close();

      // Boot worker instance #2 on the exact same database (simulating process restart)
      const inst2 = await Instance.create({ db });
      try {
        // Manager approves the request on worker #2
        await inst2.engine.update(
          'sysapproval_approver',
          approvalId,
          { state: 'approved', comments: 'Approved for immediate execution' },
          SYSTEM_SESSION,
        );
        await inst2.flush();

        // Flow context should now be `complete`
        const resumedCtx = await inst2.engine.get('sys_flow_context', contextId);
        expect(resumedCtx?.state).toBe('complete');

        // All 3 steps (`ask_for_approval`, `update_record`, `notify`) should be `complete`
        const steps = await inst2.engine.query('sys_flow_step', {
          query: `context=${contextId}^ORDERBYstep_index`,
        });
        expect(steps.map((s) => `${String(s.step_type)}:${String(s.state)}`)).toEqual([
          'ask_for_approval:complete',
          'update_record:complete',
          'notify:complete',
        ]);

        // Ticket state should have been updated to `in_progress` by step 2
        const updatedTicket = await inst2.engine.get('x_steward_itsm_ticket', String(ticket.sys_id));
        expect(updatedTicket?.state).toBe('in_progress');

        // Outbound email should have been delivered to alice@example.com by step 3
        expect(inst2.events.sentEmails.length).toBe(1);
        const email = inst2.events.sentEmails[0]!;
        expect(email.recipients).toEqual(['alice@example.com']);
        expect(email.subject).toBe(`[Approved] P1 Ticket ${String(ticket.number)}: Production DB primary failover`);
      } finally {
        await inst2.scripts.close();
        await inst2.events.close();
      }
    } finally {
      await db.close();
    }
  });

  it('executes onRejectSteps when an approval is rejected and supports wait_for_condition + if branching', async () => {
    const inst = await Instance.create();
    try {
      await inst.apps.deployPackage(inst.engine, itsmApp, SYSTEM_SESSION);

      // 1. Test approval rejection running onRejectSteps (downgrading priority from '1' to '3')
      const adminUser = (await inst.engine.query('sys_user', { query: 'user_name=admin', limit: 1 }))[0]!;
      const tkt = await inst.engine.insert(
        'x_steward_itsm_ticket',
        {
          short_description: 'False alarm P1',
          priority: '1',
          state: 'new',
          approver: adminUser.sys_id,
        },
        SYSTEM_SESSION,
      );

      const approvals = await inst.engine.query('sysapproval_approver', {
        query: `document_id=${String(tkt.sys_id)}`,
      });
      expect(approvals.length).toBe(1);

      await inst.engine.update(
        'sysapproval_approver',
        String(approvals[0]!.sys_id),
        { state: 'rejected', comments: 'Not a critical outage' },
        SYSTEM_SESSION,
      );
      await inst.flush();

      const reloadedTkt = await inst.engine.get('x_steward_itsm_ticket', String(tkt.sys_id));
      expect(reloadedTkt?.priority).toBe('3');
      expect(reloadedTkt?.state).toBe('new'); // Post-approval `in_progress` step did not run
      expect(inst.events.sentEmails.length).toBe(0);

      // 2. Test wait_for_condition + if branching flow
      await inst.engine.insert(
        'sys_hub_flow',
        {
          name: 'Wait for On Hold then Branch',
          trigger_type: 'record_created',
          table: 'x_steward_itsm_ticket',
          condition: 'priority=2',
          active: true,
          steps: [
            {
              id: 'wait_hold',
              name: 'Wait until state is on_hold',
              type: 'wait_for_condition',
              condition: 'state=on_hold',
            },
            {
              id: 'branch_desc',
              name: 'Check if VIP',
              type: 'if',
              condition: 'short_descriptionLIKEVIP',
              thenSteps: [
                {
                  id: 'vip_log',
                  type: 'log',
                  message: 'VIP ticket ${number} placed on hold',
                },
              ],
              elseSteps: [
                {
                  id: 'std_log',
                  type: 'log',
                  message: 'Standard ticket ${number} placed on hold',
                },
              ],
            },
          ],
        },
        SYSTEM_SESSION,
      );

      const p2 = await inst.engine.insert(
        'x_steward_itsm_ticket',
        {
          short_description: 'VIP laptop replacement',
          priority: '2',
          state: 'in_progress',
        },
        SYSTEM_SESSION,
      );

      let ctxRows = await inst.engine.query('sys_flow_context', {
        query: `trigger_record=${String(p2.sys_id)}`,
      });
      expect(ctxRows[0]?.state).toBe('waiting');

      // Update ticket to `on_hold` -> resumes `wait_for_condition` and takes the VIP `thenSteps` branch!
      await inst.engine.update(
        'x_steward_itsm_ticket',
        String(p2.sys_id),
        { state: 'on_hold' },
        SYSTEM_SESSION,
      );

      ctxRows = await inst.engine.query('sys_flow_context', {
        query: `trigger_record=${String(p2.sys_id)}`,
      });
      expect(ctxRows[0]?.state).toBe('complete');
      expect(
        inst.scripts.recentLogs.some((l) => l.message === `VIP ticket ${String(p2.number)} placed on hold`),
      ).toBe(true);
    } finally {
      await inst.close();
    }
  });

  it('tracks SLA start, pause, resume (shifting planned_end_time), breach events, and completion', async () => {
    const inst = await Instance.create();
    try {
      await inst.apps.deployPackage(inst.engine, itsmApp, SYSTEM_SESSION);

      const t0 = new Date('2026-06-01T10:00:00.000Z');
      // Create a P1 ticket (SLA duration = 3600s = 1 hour)
      const tkt = await inst.engine.insert(
        'x_steward_itsm_ticket',
        {
          short_description: 'Core router packet loss',
          priority: '1',
          state: 'in_progress',
        },
        SYSTEM_SESSION,
      );

      // Re-normalize start_time to deterministic t0 for exact timer assertions
      const slaRows = await inst.engine.query('task_sla', {
        query: `task=${String(tkt.sys_id)}`,
      });
      expect(slaRows.length).toBe(1);
      const taskSlaId = String(slaRows[0]!.sys_id);
      expect(slaRows[0]!.stage).toBe('in_progress');
      expect(slaRows[0]!.active).toBe(true);

      await inst.engine.update(
        'task_sla',
        taskSlaId,
        {
          start_time: t0.toISOString(),
          planned_end_time: new Date(t0.getTime() + 3600 * 1000).toISOString(),
        },
        SYSTEM_SESSION,
        { workflow: false },
      );

      // 1. At t0 + 10m (600s), put ticket `on_hold` -> SLA pauses
      const tPause = new Date(t0.getTime() + 600 * 1000);
      await inst.slas.onRecordWrite(
        inst.engine,
        'update',
        'x_steward_itsm_ticket',
        { ...tkt, state: 'on_hold' },
        tPause,
      );

      let taskSla = (await inst.engine.get('task_sla', taskSlaId))!;
      expect(taskSla.stage).toBe('paused');
      expect(taskSla.business_duration).toBe(600);
      expect(taskSla.percentage).toBe(16.7);

      // 2. At t0 + 30m (1800s, i.e. 1200s paused), resume ticket to `in_progress`
      //    planned_end_time must shift forward by +1200s to t0 + 4800s!
      const tResume = new Date(t0.getTime() + 1800 * 1000);
      await inst.slas.onRecordWrite(
        inst.engine,
        'update',
        'x_steward_itsm_ticket',
        { ...tkt, state: 'in_progress' },
        tResume,
      );

      taskSla = (await inst.engine.get('task_sla', taskSlaId))!;
      expect(taskSla.stage).toBe('in_progress');
      expect(taskSla.pause_duration).toBe(1200);
      expect(taskSla.planned_end_time).toBe(new Date(t0.getTime() + 4800 * 1000).toISOString());

      // 3. Tick at t0 + 4000s (would have breached without pause, but still within 4800s window)
      const tick1 = await inst.events.tick(inst.engine, new Date(t0.getTime() + 4000 * 1000));
      expect(tick1.slaBreaches).toBe(0);
      taskSla = (await inst.engine.get('task_sla', taskSlaId))!;
      expect(taskSla.has_breached).toBe(false);
      expect(taskSla.stage).toBe('in_progress');

      // 4. Tick at t0 + 5000s (past t0 + 4800s planned_end_time) -> breaches and queues `sla.breached` event!
      const tick2 = await inst.events.tick(inst.engine, new Date(t0.getTime() + 5000 * 1000));
      expect(tick2.slaBreaches).toBe(1);
      taskSla = (await inst.engine.get('task_sla', taskSlaId))!;
      expect(taskSla.has_breached).toBe(true);
      expect(taskSla.stage).toBe('breached');

      const breachEvents = await inst.engine.query('sys_event', {
        query: `name=sla.breached^instance=${String(tkt.sys_id)}`,
      });
      expect(breachEvents.length).toBe(1);

      // 5. Create a second P1 ticket and resolve it before breach -> stage = 'completed', active = false
      const tkt2 = await inst.engine.insert(
        'x_steward_itsm_ticket',
        {
          short_description: 'Quick fix P1',
          priority: '1',
          state: 'in_progress',
        },
        SYSTEM_SESSION,
      );
      await inst.engine.update(
        'x_steward_itsm_ticket',
        String(tkt2.sys_id),
        { state: 'resolved' },
        SYSTEM_SESSION,
      );
      const sla2 = (await inst.engine.query('task_sla', { query: `task=${String(tkt2.sys_id)}` }))[0]!;
      expect(sla2.stage).toBe('completed');
      expect(sla2.active).toBe(false);
      expect(sla2.has_breached).toBe(false);
    } finally {
      await inst.close();
    }
  });
});
