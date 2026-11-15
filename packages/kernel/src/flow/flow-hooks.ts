import {
  EncodedQueryError,
  describeIssues,
  flowStepSchema,
  parseEncodedQuery,
} from '@steward/shared';
import { z } from 'zod';
import type { HookRegistry, SystemHook } from '../data/hooks';
import { ValidationError } from '../errors';

const stepsArraySchema = z.array(flowStepSchema);

function validateEncodedQuery(raw: unknown, label: string): void {
  if (typeof raw !== 'string' || !raw.trim()) return;
  try {
    parseEncodedQuery(raw);
  } catch (e) {
    if (e instanceof EncodedQueryError) {
      throw new ValidationError(`Invalid ${label}: ${e.message}`);
    }
    throw e;
  }
}

export function flowHooks(): SystemHook[] {
  return [
    {
      name: 'sys_hub_flow: validate',
      table: 'sys_hub_flow',
      when: 'before',
      operations: ['insert', 'update'],
      run({ engine, current }) {
        const triggerType = String(current.trigger_type ?? 'record_created');
        if (triggerType === 'event') {
          if (!String(current.event_name ?? '').trim()) {
            throw new ValidationError('Event-triggered flows require event_name');
          }
        } else {
          const tbl = String(current.table ?? '').trim();
          if (!tbl || !engine.meta.hasTable(tbl)) {
            throw new ValidationError(`Flow requires an existing target table (got "${tbl}")`);
          }
        }
        validateEncodedQuery(current.condition, 'flow condition');

        let steps = current.steps ?? [];
        if (typeof steps === 'string') {
          try {
            steps = JSON.parse(steps);
          } catch (e) {
            throw new ValidationError(`Invalid flow steps JSON: ${(e as Error).message}`);
          }
        }
        const parsed = stepsArraySchema.safeParse(steps);
        if (!parsed.success) {
          throw new ValidationError('Invalid flow steps', describeIssues(parsed.error));
        }
        current.steps = parsed.data;
      },
    },
    {
      name: 'sys_hub_flow: reload cache',
      table: 'sys_hub_flow',
      when: 'after',
      operations: ['insert', 'update', 'delete'],
      async run({ engine }) {
        if (engine.flows) await engine.flows.load(engine.db);
      },
    },
    {
      name: 'contract_sla: validate',
      table: 'contract_sla',
      when: 'before',
      operations: ['insert', 'update'],
      run({ engine, current }) {
        const tbl = String(current.collection ?? '').trim();
        if (!tbl || !engine.meta.hasTable(tbl)) {
          throw new ValidationError(`SLA definition requires an existing target table (got "${tbl}")`);
        }
        const dur = Number(current.duration_seconds ?? 3600);
        if (!Number.isFinite(dur) || dur <= 0) {
          throw new ValidationError('contract_sla.duration_seconds must be a positive integer');
        }
        validateEncodedQuery(current.start_condition, 'SLA start_condition');
        validateEncodedQuery(current.pause_condition, 'SLA pause_condition');
        validateEncodedQuery(current.stop_condition, 'SLA stop_condition');
        validateEncodedQuery(current.reset_condition, 'SLA reset_condition');
      },
    },
    {
      name: 'contract_sla: reload cache',
      table: 'contract_sla',
      when: 'after',
      operations: ['insert', 'update', 'delete'],
      async run({ engine }) {
        if (engine.slas) await engine.slas.load(engine.db);
      },
    },
  ];
}

export function registerFlowHooks(registry: HookRegistry): void {
  registry.register(...flowHooks());
}
