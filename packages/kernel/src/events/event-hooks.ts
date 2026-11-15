import { EncodedQueryError, parseEncodedQuery } from '@steward/shared';
import type { HookRegistry, SystemHook } from '../data/hooks';
import { ValidationError } from '../errors';
import { checkScriptSyntax } from '../script/sandbox';
import { nextCronDate, parseCron } from './cron';

/**
 * Validation and cache-reload hooks for Phase 5 system tables:
 * - `sysevent_script_action` (Script Actions)
 * - `sysevent_email_action` (Email Notifications)
 * - `sys_trigger` (Scheduled Jobs)
 * - `sys_script_client` (Client Scripts)
 * - `sys_ui_policy` & `sys_ui_policy_action` (UI Policies)
 */
export function eventHooks(): SystemHook[] {
  const reloadEvents: SystemHook['run'] = async ({ engine }) => {
    await engine.events?.load(engine.db);
  };

  return [
    {
      name: 'sysevent_script_action: validate',
      table: 'sysevent_script_action',
      when: 'before',
      operations: ['insert', 'update'],
      run({ current }) {
        const name = String(current.name ?? '').trim();
        if (!name) throw new ValidationError('Script action name is required');
        const eventName = String(current.event_name ?? '').trim();
        if (!eventName) throw new ValidationError('Event name is required');
        current.event_name = eventName;

        if (typeof current.condition_script === 'string' && current.condition_script.trim()) {
          checkScriptSyntax(current.condition_script, { expression: true, label: `Script action "${name}"` });
        }
        const script = String(current.script ?? '');
        if (!script.trim()) throw new ValidationError('Script action script is required');
        checkScriptSyntax(script, { label: `Script action "${name}"` });
      },
    },
    {
      name: 'sysevent_script_action: reload cache',
      table: 'sysevent_script_action',
      when: 'after',
      operations: ['insert', 'update', 'delete'],
      run: reloadEvents,
    },
    {
      name: 'sysevent_email_action: validate',
      table: 'sysevent_email_action',
      when: 'before',
      operations: ['insert', 'update'],
      run({ engine, current }) {
        const name = String(current.name ?? '').trim();
        if (!name) throw new ValidationError('Email notification name is required');
        const collection = String(current.collection ?? '').trim();
        if (!collection || !engine.meta.hasTable(collection)) {
          throw new ValidationError(`Email notification "${name}" references unknown table "${collection}"`);
        }
        if (current.when_to_send === 'event') {
          const ev = String(current.event_name ?? '').trim();
          if (!ev) throw new ValidationError(`Email notification "${name}" requires event_name when when_to_send is "event"`);
          current.event_name = ev;
        }
        if (typeof current.filter_condition === 'string' && current.filter_condition.trim()) {
          try {
            parseEncodedQuery(current.filter_condition);
          } catch (e) {
            if (e instanceof EncodedQueryError) {
              throw new ValidationError(`Email notification "${name}" has invalid filter_condition: ${e.message}`);
            }
            throw e;
          }
        }
        if (typeof current.condition === 'string' && current.condition.trim()) {
          checkScriptSyntax(current.condition, { expression: true, label: `Email notification "${name}"` });
        }
      },
    },
    {
      name: 'sysevent_email_action: reload cache',
      table: 'sysevent_email_action',
      when: 'after',
      operations: ['insert', 'update', 'delete'],
      run: reloadEvents,
    },
    {
      name: 'sys_trigger: validate',
      table: 'sys_trigger',
      when: 'before',
      operations: ['insert', 'update'],
      run({ operation, current }) {
        const name = String(current.name ?? '').trim();
        if (!name) throw new ValidationError('Scheduled job name is required');
        const script = String(current.script ?? '');
        if (!script.trim()) throw new ValidationError('Scheduled job script is required');
        checkScriptSyntax(script, { label: `Scheduled job "${name}"` });

        const triggerType = String(current.trigger_type ?? 'interval');
        if (triggerType === 'interval') {
          const secs = Number(current.repeat_seconds ?? 60);
          if (!Number.isInteger(secs) || secs < 1) {
            throw new ValidationError(`Scheduled job "${name}": repeat_seconds must be a positive integer`);
          }
        } else if (triggerType === 'cron') {
          const expr = String(current.cron_expression ?? '').trim();
          if (!expr) throw new ValidationError(`Scheduled job "${name}" requires cron_expression when trigger_type is "cron"`);
          parseCron(expr);
          current.cron_expression = expr;
          if (operation === 'insert' && !current.next_action) {
            current.next_action = nextCronDate(expr).toISOString();
          }
        }
        if (operation === 'insert' && !current.next_action && triggerType !== 'cron') {
          current.next_action = new Date().toISOString();
        }
      },
    },
    {
      name: 'sys_script_client: validate',
      table: 'sys_script_client',
      when: 'before',
      operations: ['insert', 'update'],
      run({ engine, current }) {
        const name = String(current.name ?? '').trim();
        if (!name) throw new ValidationError('Client script name is required');
        const table = String(current.table ?? '').trim();
        if (!table || !engine.meta.hasTable(table)) {
          throw new ValidationError(`Client script "${name}" references unknown table "${table}"`);
        }
        const type = String(current.type ?? 'onLoad');
        if (type === 'onChange') {
          const fieldName = String(current.field_name ?? '').trim();
          if (!fieldName) {
            throw new ValidationError(`Client script "${name}" requires field_name when type is "onChange"`);
          }
          if (!engine.meta.fields(table).has(fieldName)) {
            throw new ValidationError(`Client script "${name}" references unknown field "${table}.${fieldName}"`);
          }
          current.field_name = fieldName;
        }
        const script = String(current.script ?? '');
        if (!script.trim()) throw new ValidationError('Client script is required');
        checkScriptSyntax(script, { label: `Client script "${name}"` });
      },
    },
    {
      name: 'sys_ui_policy: validate',
      table: 'sys_ui_policy',
      when: 'before',
      operations: ['insert', 'update'],
      run({ engine, current }) {
        const desc = String(current.short_description ?? '').trim();
        if (!desc) throw new ValidationError('UI policy short_description is required');
        const table = String(current.table ?? '').trim();
        if (!table || !engine.meta.hasTable(table)) {
          throw new ValidationError(`UI policy "${desc}" references unknown table "${table}"`);
        }
        if (typeof current.conditions === 'string' && current.conditions.trim()) {
          try {
            parseEncodedQuery(current.conditions);
          } catch (e) {
            if (e instanceof EncodedQueryError) {
              throw new ValidationError(`UI policy "${desc}" has invalid conditions: ${e.message}`);
            }
            throw e;
          }
        }
      },
    },
    {
      name: 'sys_ui_policy_action: validate',
      table: 'sys_ui_policy_action',
      when: 'before',
      operations: ['insert', 'update'],
      async run({ engine, current }) {
        const policyId = String(current.ui_policy ?? '').trim();
        if (!policyId) throw new ValidationError('UI policy action requires ui_policy');
        const policy = await engine.get('sys_ui_policy', policyId);
        if (!policy) throw new ValidationError(`UI policy "${policyId}" does not exist`);
        const table = String(policy.table ?? '');
        const field = String(current.field ?? '').trim();
        if (!field || !engine.meta.hasTable(table) || !engine.meta.fields(table).has(field)) {
          throw new ValidationError(`UI policy action references unknown field "${table}.${field}"`);
        }
        current.field = field;
      },
    },
  ];
}

export function registerEventHooks(registry: HookRegistry): void {
  registry.register(...eventHooks());
}
