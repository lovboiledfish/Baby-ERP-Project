import {
  EncodedQueryError,
  flowStepSchema,
  parseEncodedQuery,
  type FlowStepDef,
  type QueryAst,
} from '@steward/shared';
import { z } from 'zod';
import type { DataEngine, RecordValues } from '../data/data-engine';
import type { Operation } from '../data/hooks';
import type { Db } from '../db/db';
import type { MetaService } from '../meta/meta-service';
import { matchesRecord } from '../script/match-record';
import type { ScriptEventBinding } from '../script/sandbox';
import type { ScriptService } from '../script/script-service';
import { SYSTEM_SESSION, withScope, type Session } from '../session';
import { isUuid } from '../util';

export interface FlowDefinition {
  sysId: string;
  name: string;
  description: string | null;
  scope: string;
  triggerType: 'record_created' | 'record_updated' | 'record_created_or_updated' | 'event';
  table: string | null;
  eventName: string | null;
  condition: QueryAst | null;
  conditionRaw: string | null;
  runAs: 'system' | 'initiating_user';
  steps: FlowStepDef[];
  broken: boolean;
}

interface FlowRow {
  sys_id: string;
  name: string;
  description: string | null;
  sys_scope: string | null;
  trigger_type: string;
  table: string | null;
  event_name: string | null;
  condition: string | null;
  run_as: string | null;
  steps: unknown;
}

interface PersistedContextData {
  steps: FlowStepDef[];
  scope: string;
  initiator: string;
  variables: Record<string, unknown>;
  event?: ScriptEventBinding | null;
}

const stepsArraySchema = z.array(flowStepSchema);

const INTERNAL_SKIP_TABLES: ReadonlySet<string> = new Set([
  'sys_flow_context',
  'sys_flow_step',
  'sys_event',
  'sys_email',
  'sys_audit',
  'sys_journal_field',
  'sys_number',
  'sys_update_xml',
  'sys_metadata_file',
]);

/**
 * Durable Flow Engine (`sys_hub_flow`, `sys_flow_context`, `sys_flow_step`, `sysapproval_approver`).
 *
 * Every flow execution persists its state machine (`current_step`, `state`, and `context_data`)
 * in `sys_flow_context` and logs each step in `sys_flow_step`. When a flow reaches an
 * `ask_for_approval` or `wait_for_condition` step, it transitions to `state = 'waiting'` and
 * yields. When the approval or record condition is satisfied—even after a server/worker restart—
 * the context is reloaded from Postgres and resumes at `current_step + 1`.
 */
export class FlowService {
  private flows: FlowDefinition[] = [];
  private activeContextLocks = new Set<string>();
  version = 0;

  constructor(
    private readonly meta: MetaService,
    private readonly scripts: ScriptService,
  ) {}

  async load(db: Db): Promise<void> {
    if (!this.meta.hasTable('sys_hub_flow')) return;
    const res = await db.query<FlowRow>(
      `SELECT "sys_id", "name", "description", "sys_scope", "trigger_type", "table",
              "event_name", "condition", "run_as", "steps"
         FROM "sys_hub_flow"
        WHERE "active" IS NOT FALSE
        ORDER BY "sys_created_on" ASC, "sys_id" ASC`,
    );

    const flows: FlowDefinition[] = [];
    for (const r of res.rows) {
      let broken = false;
      let condition: QueryAst | null = null;
      if (r.condition && r.condition.trim()) {
        try {
          condition = parseEncodedQuery(r.condition);
          if (condition.groups.length === 0) condition = null;
        } catch (e) {
          if (!(e instanceof EncodedQueryError)) throw e;
          broken = true;
        }
      }

      let rawSteps: unknown = r.steps;
      if (typeof rawSteps === 'string') {
        try {
          rawSteps = JSON.parse(rawSteps);
        } catch {
          broken = true;
        }
      }
      const parsedSteps = stepsArraySchema.safeParse(rawSteps ?? []);
      if (!parsedSteps.success) {
        broken = true;
      }

      const triggerType = (
        ['record_created', 'record_updated', 'record_created_or_updated', 'event'] as const
      ).includes(r.trigger_type as never)
        ? (r.trigger_type as FlowDefinition['triggerType'])
        : 'record_created';

      if (triggerType !== 'event' && !r.table) broken = true;
      if (triggerType === 'event' && !r.event_name) broken = true;

      flows.push({
        sysId: r.sys_id,
        name: r.name,
        description: r.description ?? null,
        scope: r.sys_scope ?? 'global',
        triggerType,
        table: r.table ?? null,
        eventName: r.event_name ?? null,
        condition,
        conditionRaw: r.condition ?? null,
        runAs: r.run_as === 'initiating_user' ? 'initiating_user' : 'system',
        steps: parsedSteps.success ? parsedSteps.data : [],
        broken,
      });
    }

    this.flows = flows;
    this.version++;
  }

  listFlows(): FlowDefinition[] {
    return [...this.flows];
  }

  /**
   * Handle record insert/update triggers, approval state transitions on `sysapproval_approver`,
   * and `wait_for_condition` resumptions.
   */
  async onRecordWrite(
    engine: DataEngine,
    operation: Operation,
    table: string,
    current: RecordValues,
    session: Session,
    previous?: RecordValues,
  ): Promise<void> {
    if (operation !== 'insert' && operation !== 'update') return;
    if (INTERNAL_SKIP_TABLES.has(table)) return;
    if (!this.meta.hasTable('sys_hub_flow')) return;

    // 1. If a `sysapproval_approver` row transitioned to `approved` or `rejected`, resume its waiting flow context!
    if (table === 'sysapproval_approver' && operation === 'update') {
      const newState = String(current.state ?? '');
      const oldState = String(previous?.state ?? '');
      const contextId = typeof current.flow_context === 'string' ? current.flow_context : null;
      if (
        contextId &&
        (newState === 'approved' || newState === 'rejected') &&
        newState !== oldState
      ) {
        await this.resumeFromApproval(
          engine,
          contextId,
          String(current.sys_id),
          newState,
          current.comments != null ? String(current.comments) : '',
        );
      }
      return;
    }

    // 2. If any `waiting` flow contexts on `(table, current.sys_id)` are waiting on `wait_for_condition`, check them.
    if (operation === 'update' && typeof current.sys_id === 'string') {
      await this.checkWaitingConditionContexts(engine, table, current);
    }

    // 3. Trigger matching record-based flows.
    if (!this.meta.hasTable(table)) return;
    const ancestors = new Set(this.meta.ancestors(table).map((t) => t.name));

    const matching = this.flows.filter((f) => {
      if (f.broken || !f.table || !ancestors.has(f.table)) return false;
      if (operation === 'insert') {
        return f.triggerType === 'record_created' || f.triggerType === 'record_created_or_updated';
      }
      return f.triggerType === 'record_updated' || f.triggerType === 'record_created_or_updated';
    });

    for (const flow of matching) {
      const lockKey = `${flow.sysId}:${String(current.sys_id ?? '')}`;
      if (this.activeContextLocks.has(lockKey)) continue;

      if (flow.condition) {
        const matchesNow = await matchesRecord(engine, table, current, flow.condition, SYSTEM_SESSION);
        if (!matchesNow) continue;
        // On update, only trigger when transitioning into matching the condition (unless no previous record)
        if (operation === 'update' && previous) {
          const matchedBefore = await matchesRecord(engine, table, previous, flow.condition, SYSTEM_SESSION);
          if (matchedBefore) continue;
        }
      }

      // Avoid starting a duplicate flow if one is already waiting/in_progress for this flow + record
      if (typeof current.sys_id === 'string') {
        const existingActive = await engine.query('sys_flow_context', {
          query: `flow=${flow.sysId}^trigger_record=${current.sys_id}^stateINin_progress,waiting`,
          fields: ['sys_id'],
          limit: 1,
        });
        if (existingActive.length > 0) continue;
      }

      this.activeContextLocks.add(lockKey);
      try {
        await this.startFlow(engine, flow, table, current, undefined, session);
      } finally {
        this.activeContextLocks.delete(lockKey);
      }
    }
  }

  /**
   * Trigger any active `event`-triggered flows matching `event.name`.
   */
  async onEvent(
    engine: DataEngine,
    event: ScriptEventBinding,
    targetTable: string | null,
    targetRecord: RecordValues | null,
  ): Promise<void> {
    if (!this.meta.hasTable('sys_hub_flow')) return;
    const matching = this.flows.filter(
      (f) => !f.broken && f.triggerType === 'event' && f.eventName === event.name,
    );
    for (const flow of matching) {
      if (flow.condition && targetTable && targetRecord && this.meta.hasTable(targetTable)) {
        const ok = await matchesRecord(engine, targetTable, targetRecord, flow.condition, SYSTEM_SESSION);
        if (!ok) continue;
      }
      await this.startFlow(
        engine,
        flow,
        targetTable,
        targetRecord ?? {},
        event,
        SYSTEM_SESSION,
      );
    }
  }

  /**
   * Start a new durable flow execution context (`sys_flow_context`) and run steps until completion or a wait point.
   */
  async startFlow(
    engine: DataEngine,
    flow: FlowDefinition,
    triggerTable: string | null,
    triggerRecord: RecordValues,
    event: ScriptEventBinding | undefined,
    session: Session,
  ): Promise<string> {
    const now = new Date().toISOString();
    const recordSysId = typeof triggerRecord.sys_id === 'string' && isUuid(triggerRecord.sys_id)
      ? triggerRecord.sys_id
      : null;

    const contextData: PersistedContextData = {
      steps: structuredClone(flow.steps),
      scope: flow.scope,
      initiator: session.userName,
      variables: {},
      event: event ?? null,
    };

    const createdCtx = await engine.insert(
      'sys_flow_context',
      {
        name: flow.name,
        flow: flow.sysId,
        state: 'in_progress',
        trigger_table: triggerTable,
        trigger_record: recordSysId,
        current_step: 0,
        context_data: contextData as unknown as Record<string, unknown>,
        started_on: now,
        sys_scope: flow.scope,
      },
      SYSTEM_SESSION,
      { workflow: false },
    );
    const contextSysId = String(createdCtx.sys_id);

    await this.executeFromStep(engine, contextSysId, 0, contextData, triggerTable, recordSysId, triggerRecord);
    return contextSysId;
  }

  /**
   * Resume a `waiting` flow context when its `sysapproval_approver` record is approved or rejected.
   */
  async resumeFromApproval(
    engine: DataEngine,
    contextSysId: string,
    approvalSysId: string,
    decision: 'approved' | 'rejected',
    comments: string,
  ): Promise<void> {
    const ctxRow = await engine.get('sys_flow_context', contextSysId);
    if (!ctxRow || ctxRow.state !== 'waiting') return;

    const stepIndex = typeof ctxRow.current_step === 'number' ? ctxRow.current_step : 0;
    const triggerTable = typeof ctxRow.trigger_table === 'string' ? ctxRow.trigger_table : null;
    const triggerRecordId = typeof ctxRow.trigger_record === 'string' ? ctxRow.trigger_record : null;
    const contextData = this.parseContextData(ctxRow.context_data);

    contextData.variables.approval = decision;
    contextData.variables.approval_comments = comments;
    contextData.variables.approval_sys_id = approvalSysId;

    // Mark the waiting sys_flow_step as complete
    const waitingSteps = await engine.query('sys_flow_step', {
      query: `context=${contextSysId}^step_index=${stepIndex}^state=waiting`,
      limit: 1,
    });
    const now = new Date().toISOString();
    if (waitingSteps[0]?.sys_id) {
      await engine.update(
        'sys_flow_step',
        String(waitingSteps[0].sys_id),
        {
          state: 'complete',
          output: { decision, approvalSysId, comments },
          completed_on: now,
        },
        SYSTEM_SESSION,
        { workflow: false },
      );
    }

    const pausedStep = contextData.steps[stepIndex];
    if (decision === 'rejected') {
      const nextStep = contextData.steps[stepIndex + 1];
      const nextIsIf = nextStep?.type === 'if';
      if (pausedStep?.type === 'ask_for_approval' && pausedStep.onRejectSteps?.length) {
        // Replace remaining steps after stepIndex with onRejectSteps
        contextData.steps.splice(
          stepIndex + 1,
          contextData.steps.length - (stepIndex + 1),
          ...structuredClone(pausedStep.onRejectSteps),
        );
      } else if (!nextIsIf) {
        // Linear flow without onRejectSteps or subsequent `if` check: cancel remaining post-approval steps
        await engine.update(
          'sys_flow_context',
          contextSysId,
          {
            state: 'cancelled',
            waiting_for_approval: null,
            context_data: contextData as unknown as Record<string, unknown>,
            completed_on: now,
          },
          SYSTEM_SESSION,
          { workflow: false },
        );
        return;
      }
    }

    await engine.update(
      'sys_flow_context',
      contextSysId,
      {
        state: 'in_progress',
        waiting_for_approval: null,
        current_step: stepIndex + 1,
        context_data: contextData as unknown as Record<string, unknown>,
      },
      SYSTEM_SESSION,
      { workflow: false },
    );

    const latestRecord =
      triggerTable && triggerRecordId && this.meta.hasTable(triggerTable)
        ? ((await engine.get(triggerTable, triggerRecordId)) ?? {})
        : {};

    await this.executeFromStep(
      engine,
      contextSysId,
      stepIndex + 1,
      contextData,
      triggerTable,
      triggerRecordId,
      latestRecord,
    );
  }

  private async checkWaitingConditionContexts(
    engine: DataEngine,
    table: string,
    current: RecordValues,
  ): Promise<void> {
    const sysId = String(current.sys_id ?? '');
    if (!sysId) return;
    const waitingContexts = await engine.query('sys_flow_context', {
      query: `state=waiting^trigger_table=${table}^trigger_record=${sysId}`,
    });
    for (const ctxRow of waitingContexts) {
      if (ctxRow.waiting_for_approval) continue; // waiting on approval, not record condition
      const contextSysId = String(ctxRow.sys_id);
      const stepIndex = typeof ctxRow.current_step === 'number' ? ctxRow.current_step : 0;
      const contextData = this.parseContextData(ctxRow.context_data);
      const step = contextData.steps[stepIndex];
      if (!step || step.type !== 'wait_for_condition') continue;

      let matched = false;
      try {
        const ast = parseEncodedQuery(step.condition);
        matched = await matchesRecord(engine, table, current, ast, SYSTEM_SESSION);
      } catch {
        matched = false;
      }
      if (!matched) continue;

      const now = new Date().toISOString();
      const waitingSteps = await engine.query('sys_flow_step', {
        query: `context=${contextSysId}^step_index=${stepIndex}^state=waiting`,
        limit: 1,
      });
      if (waitingSteps[0]?.sys_id) {
        await engine.update(
          'sys_flow_step',
          String(waitingSteps[0].sys_id),
          {
            state: 'complete',
            output: { matched: true },
            completed_on: now,
          },
          SYSTEM_SESSION,
          { workflow: false },
        );
      }

      await engine.update(
        'sys_flow_context',
        contextSysId,
        {
          state: 'in_progress',
          current_step: stepIndex + 1,
        },
        SYSTEM_SESSION,
        { workflow: false },
      );

      await this.executeFromStep(
        engine,
        contextSysId,
        stepIndex + 1,
        contextData,
        table,
        sysId,
        current,
      );
    }
  }

  private async executeFromStep(
    engine: DataEngine,
    contextSysId: string,
    startIndex: number,
    contextData: PersistedContextData,
    triggerTable: string | null,
    triggerRecordId: string | null,
    initialRecord: RecordValues,
  ): Promise<void> {
    let currentRecord = { ...initialRecord };
    const execSession = withScope(SYSTEM_SESSION, contextData.scope || 'global');

    for (let i = startIndex; i < contextData.steps.length; i++) {
      const step = contextData.steps[i]!;
      const stepName = step.name ?? step.id ?? `${step.type}_${i + 1}`;
      const stepStarted = new Date().toISOString();

      // Persist current_step before executing
      await engine.update(
        'sys_flow_context',
        contextSysId,
        {
          current_step: i,
          context_data: contextData as unknown as Record<string, unknown>,
        },
        SYSTEM_SESSION,
        { workflow: false },
      );

      const stepRow = await engine.insert(
        'sys_flow_step',
        {
          context: contextSysId,
          step_index: i,
          step_id: step.id ?? `step_${i + 1}`,
          step_name: stepName,
          step_type: step.type,
          state: 'in_progress',
          input: step as unknown as Record<string, unknown>,
          started_on: stepStarted,
          sys_scope: contextData.scope || 'global',
        },
        SYSTEM_SESSION,
        { workflow: false },
      );
      const stepRowId = String(stepRow.sys_id);

      try {
        // Refresh triggering record if it exists in DB
        if (triggerTable && triggerRecordId && this.meta.hasTable(triggerTable)) {
          const fresh = await engine.get(triggerTable, triggerRecordId);
          if (fresh) currentRecord = fresh;
        }

        if (step.type === 'ask_for_approval') {
          const approverId = await this.resolveApproverId(engine, step, currentRecord, contextData);
          const dueDate = step.dueInSeconds
            ? new Date(Date.now() + step.dueInSeconds * 1000).toISOString()
            : null;

          const approval = await engine.insert(
            'sysapproval_approver',
            {
              state: 'requested',
              approver: approverId,
              source_table: triggerTable,
              document_id: triggerRecordId,
              flow_context: contextSysId,
              due_date: dueDate,
              sys_scope: contextData.scope || 'global',
            },
            SYSTEM_SESSION,
            { workflow: false },
          );
          const approvalId = String(approval.sys_id);

          await engine.update(
            'sys_flow_step',
            stepRowId,
            {
              state: 'waiting',
              output: { approvalSysId: approvalId, approver: approverId },
            },
            SYSTEM_SESSION,
            { workflow: false },
          );

          await engine.update(
            'sys_flow_context',
            contextSysId,
            {
              state: 'waiting',
              current_step: i,
              waiting_for_approval: approvalId,
              context_data: contextData as unknown as Record<string, unknown>,
            },
            SYSTEM_SESSION,
            { workflow: false },
          );
          return; // Yield execution until approval decision arrives
        }

        if (step.type === 'wait_for_condition') {
          let alreadyMet = false;
          if (triggerTable && this.meta.hasTable(triggerTable)) {
            const ast = parseEncodedQuery(step.condition);
            alreadyMet = await matchesRecord(engine, triggerTable, currentRecord, ast, SYSTEM_SESSION);
          }
          if (!alreadyMet) {
            await engine.update(
              'sys_flow_step',
              stepRowId,
              {
                state: 'waiting',
                output: { waitingForCondition: step.condition },
              },
              SYSTEM_SESSION,
              { workflow: false },
            );
            await engine.update(
              'sys_flow_context',
              contextSysId,
              {
                state: 'waiting',
                current_step: i,
                context_data: contextData as unknown as Record<string, unknown>,
              },
              SYSTEM_SESSION,
              { workflow: false },
            );
            return; // Yield until record update satisfies condition
          }
        }

        const output = await this.executeSingleStep(
          engine,
          step,
          i,
          contextData,
          triggerTable,
          triggerRecordId,
          currentRecord,
          execSession,
        );

        await engine.update(
          'sys_flow_step',
          stepRowId,
          {
            state: 'complete',
            output,
            completed_on: new Date().toISOString(),
          },
          SYSTEM_SESSION,
          { workflow: false },
        );
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        const now = new Date().toISOString();
        await engine.update(
          'sys_flow_step',
          stepRowId,
          {
            state: 'error',
            error_message: msg,
            completed_on: now,
          },
          SYSTEM_SESSION,
          { workflow: false },
        );
        await engine.update(
          'sys_flow_context',
          contextSysId,
          {
            state: 'error',
            error_message: msg,
            completed_on: now,
            context_data: contextData as unknown as Record<string, unknown>,
          },
          SYSTEM_SESSION,
          { workflow: false },
        );
        this.scripts.recordLog('error', `Flow step "${stepName}" failed: ${msg}`, `sys_hub_flow:${contextSysId}`);
        return;
      }
    }

    // All steps completed!
    await engine.update(
      'sys_flow_context',
      contextSysId,
      {
        state: 'complete',
        waiting_for_approval: null,
        completed_on: new Date().toISOString(),
        context_data: contextData as unknown as Record<string, unknown>,
      },
      SYSTEM_SESSION,
      { workflow: false },
    );
  }

  private async executeSingleStep(
    engine: DataEngine,
    step: FlowStepDef,
    stepIndex: number,
    contextData: PersistedContextData,
    triggerTable: string | null,
    triggerRecordId: string | null,
    currentRecord: RecordValues,
    execSession: Session,
  ): Promise<Record<string, unknown>> {
    switch (step.type) {
      case 'update_record': {
        const targetTable = step.table ?? triggerTable;
        const targetId = step.recordSysId
          ? this.interpolate(step.recordSysId, currentRecord, contextData)
          : triggerRecordId;
        if (!targetTable || !targetId) {
          throw new Error('update_record step requires a target table and record sys_id');
        }
        const resolvedValues: RecordValues = {};
        for (const [k, v] of Object.entries(step.values)) {
          resolvedValues[k] = typeof v === 'string' ? this.interpolate(v, currentRecord, contextData) : v;
        }
        await engine.update(targetTable, targetId, resolvedValues, execSession);
        return { table: targetTable, sysId: targetId, updatedFields: Object.keys(resolvedValues) };
      }

      case 'create_record': {
        const resolvedValues: RecordValues = {};
        for (const [k, v] of Object.entries(step.values)) {
          resolvedValues[k] = typeof v === 'string' ? this.interpolate(v, currentRecord, contextData) : v;
        }
        const created = await engine.insert(step.table, resolvedValues, execSession);
        const createdId = String(created.sys_id);
        if (step.id) {
          contextData.variables[`${step.id}_sys_id`] = createdId;
        }
        contextData.variables.last_created_sys_id = createdId;
        return { table: step.table, sysId: createdId };
      }

      case 'log': {
        const message = this.interpolate(step.message, currentRecord, contextData);
        const level = step.level ?? 'info';
        this.scripts.recordLog(level, message, `flow:${contextData.scope}`);
        return { level, message };
      }

      case 'event': {
        const parm1 = step.parm1 ? this.interpolate(step.parm1, currentRecord, contextData) : '';
        const parm2 = step.parm2 ? this.interpolate(step.parm2, currentRecord, contextData) : '';
        const ev = await engine.insert(
          'sys_event',
          {
            name: step.eventName,
            table: triggerTable,
            instance: triggerRecordId,
            parm1,
            parm2,
            state: 'ready',
            claimed_by: contextData.initiator,
            sys_scope: contextData.scope || 'global',
          },
          SYSTEM_SESSION,
          { workflow: false },
        );
        return { eventSysId: String(ev.sys_id), eventName: step.eventName };
      }

      case 'notify': {
        const recipients = await this.resolveNotifyRecipients(engine, step, triggerTable, currentRecord, contextData);
        const subject = this.interpolate(step.subject, currentRecord, contextData);
        const body = this.interpolate(step.body, currentRecord, contextData);
        if (!recipients.length) {
          return { skipped: true, reason: 'No recipients resolved' };
        }
        const email = await engine.insert(
          'sys_email',
          {
            subject,
            recipients: recipients.join(', '),
            body,
            type: 'send-ready',
            target_table: triggerTable,
            instance: triggerRecordId,
            sys_scope: contextData.scope || 'global',
          },
          SYSTEM_SESSION,
          { workflow: false },
        );
        if (engine.events) {
          engine.events.enqueueDrain(engine);
        }
        return { emailSysId: String(email.sys_id), recipients, subject };
      }

      case 'run_script': {
        const res = await this.scripts.executeWithIncludes(engine, {
          script: step.script,
          sourceName: `sys_hub_flow/${step.name ?? step.id ?? 'step'}.js`,
          session: execSession,
          keepElevatedRoles: false,
          current:
            triggerTable && this.meta.hasTable(triggerTable)
              ? { table: triggerTable, values: currentRecord, readOnly: false }
              : undefined,
          event: contextData.event ?? undefined,
        });
        if (res.value && typeof res.value === 'object') {
          Object.assign(contextData.variables, res.value as Record<string, unknown>);
        }
        return { value: res.value ?? null };
      }

      case 'if': {
        const mergedRecord: RecordValues = {
          ...currentRecord,
          ...contextData.variables,
        };
        const ast = parseEncodedQuery(step.condition);
        let condMatched = false;
        if (triggerTable && this.meta.hasTable(triggerTable)) {
          condMatched = await matchesRecord(engine, triggerTable, mergedRecord, ast, SYSTEM_SESSION);
        } else {
          condMatched = this.evalSimpleAst(ast, mergedRecord);
        }
        const branchSteps = condMatched ? step.thenSteps : (step.elseSteps ?? []);
        if (branchSteps.length > 0) {
          contextData.steps.splice(stepIndex + 1, 0, ...structuredClone(branchSteps));
        }
        return { condition: step.condition, matched: condMatched, branchedSteps: branchSteps.length };
      }

      case 'wait_for_condition':
      case 'ask_for_approval':
        return {};
    }
  }

  private evalSimpleAst(ast: QueryAst, values: RecordValues): boolean {
    if (ast.groups.length === 0) return true;
    return ast.groups.some((group) =>
      group.every((orClause) =>
        orClause.some((cond) => {
          const actual = String(values[cond.field] ?? '');
          if (cond.operator === '=') return actual === cond.value;
          if (cond.operator === '!=') return actual !== cond.value;
          if (cond.operator === 'LIKE') return actual.toLowerCase().includes(cond.value.toLowerCase());
          if (cond.operator === 'NOT LIKE') return !actual.toLowerCase().includes(cond.value.toLowerCase());
          if (cond.operator === 'ISEMPTY') return actual === '';
          if (cond.operator === 'ISNOTEMPTY') return actual !== '';
          return false;
        }),
      ),
    );
  }

  private async resolveApproverId(
    engine: DataEngine,
    step: Extract<FlowStepDef, { type: 'ask_for_approval' }>,
    currentRecord: RecordValues,
    contextData: PersistedContextData,
  ): Promise<string | null> {
    let rawToken = '';
    if (step.approverField && currentRecord[step.approverField] != null) {
      rawToken = String(currentRecord[step.approverField]);
    } else if (step.approver) {
      rawToken = this.interpolate(step.approver, currentRecord, contextData);
    }
    rawToken = rawToken.trim();
    if (!rawToken) return null;
    if (isUuid(rawToken)) return rawToken;

    const users = await engine.query('sys_user', {
      query: `user_name=${rawToken}^ORemail=${rawToken}`,
      fields: ['sys_id'],
      limit: 1,
    });
    return users[0]?.sys_id ? String(users[0].sys_id) : null;
  }

  private async resolveNotifyRecipients(
    engine: DataEngine,
    step: Extract<FlowStepDef, { type: 'notify' }>,
    triggerTable: string | null,
    currentRecord: RecordValues,
    contextData: PersistedContextData,
  ): Promise<string[]> {
    const emails = new Set<string>();
    const addToken = async (token: string) => {
      const t = token.trim();
      if (!t) return;
      if (t.includes('@')) {
        emails.add(t);
        return;
      }
      if (isUuid(t)) {
        const user = await engine.get('sys_user', t);
        if (user && typeof user.email === 'string' && user.email.includes('@')) {
          emails.add(user.email.trim());
          return;
        }
        const group = await engine.get('sys_user_group', t);
        if (group) {
          if (typeof group.email === 'string' && group.email.includes('@')) {
            emails.add(group.email.trim());
          }
          const members = await engine.query('sys_user_grmember', {
            query: `group=${t}`,
            fields: ['user'],
          });
          for (const m of members) {
            if (typeof m.user === 'string' && isUuid(m.user)) {
              const u = await engine.get('sys_user', m.user);
              if (u && typeof u.email === 'string' && u.email.includes('@')) {
                emails.add(u.email.trim());
              }
            }
          }
        }
        return;
      }
      const users = await engine.query('sys_user', {
        query: `user_name=${t}`,
        fields: ['email'],
        limit: 1,
      });
      if (users[0] && typeof users[0].email === 'string' && users[0].email.includes('@')) {
        emails.add(users[0].email.trim());
      }
    };

    for (const r of step.recipients ?? []) {
      const interpolated = this.interpolate(r, currentRecord, contextData);
      for (const part of interpolated.split(',')) {
        await addToken(part);
      }
    }

    if (triggerTable && step.recipientFields?.length) {
      for (const f of step.recipientFields) {
        const val = currentRecord[f];
        if (val != null && val !== '') {
          await addToken(String(val));
        }
      }
    }

    return [...emails];
  }

  private interpolate(
    template: string,
    currentRecord: RecordValues,
    contextData: PersistedContextData,
  ): string {
    if (!template.includes('${')) return template;
    return template.replace(/\$\{([a-zA-Z0-9_.]+)\}/g, (_match, expr: string) => {
      if (expr.startsWith('variables.')) {
        const k = expr.slice('variables.'.length);
        const v = contextData.variables[k];
        return v == null ? '' : String(v);
      }
      if (expr.startsWith('event.')) {
        const k = expr.slice('event.'.length) as keyof ScriptEventBinding;
        const v = contextData.event?.[k];
        return v == null ? '' : String(v);
      }
      const key = expr.startsWith('current.') ? expr.slice('current.'.length) : expr;
      if (key in currentRecord && currentRecord[key] != null) {
        return String(currentRecord[key]);
      }
      if (key in contextData.variables && contextData.variables[key] != null) {
        return String(contextData.variables[key]);
      }
      return '';
    });
  }

  private parseContextData(raw: unknown): PersistedContextData {
    let obj = raw;
    if (typeof obj === 'string') {
      try {
        obj = JSON.parse(obj);
      } catch {
        obj = {};
      }
    }
    const data = (obj && typeof obj === 'object' ? obj : {}) as Partial<PersistedContextData>;
    return {
      steps: Array.isArray(data.steps) ? data.steps : [],
      scope: typeof data.scope === 'string' ? data.scope : 'global',
      initiator: typeof data.initiator === 'string' ? data.initiator : 'system',
      variables: data.variables && typeof data.variables === 'object' ? data.variables : {},
      event: data.event ?? null,
    };
  }
}
