import {
  Acl,
  BusinessRule,
  ChoiceColumn,
  ClientScript,
  EmailNotification,
  Flow,
  JournalColumn,
  ReferenceColumn,
  Role,
  ScriptInclude,
  SlaDefinition,
  StringColumn,
  Table,
  UiPolicy,
  defineApp,
  type AppPackage,
  type ColumnDef,
} from '@steward/sdk';

export interface ItsmAppOptions {
  version?: string;
  extendsTable?: string;
  extraColumns?: Record<string, ColumnDef>;
}

/**
 * Build the `x_steward_itsm` dogfood application package using the `@steward/sdk` Pro-Code DSL.
 */
export function createItsmApp(opts: ItsmAppOptions = {}): AppPackage {
  const version = opts.version ?? '1.0.0';
  const schema: Record<string, ColumnDef> = {
    short_description: StringColumn({
      label: 'Short description',
      maxLength: 160,
      mandatory: true,
      display: true,
    }),
    priority: ChoiceColumn({
      label: 'Priority',
      defaultValue: '3',
      choices: [
        { value: '1', label: '1 - Critical', sequence: 100 },
        { value: '2', label: '2 - High', sequence: 200 },
        { value: '3', label: '3 - Moderate', sequence: 300 },
        { value: '4', label: '4 - Low', sequence: 400 },
      ],
    }),
    state: ChoiceColumn({
      label: 'State',
      defaultValue: 'new',
      choices: [
        { value: 'new', label: 'New', sequence: 100 },
        { value: 'in_progress', label: 'In Progress', sequence: 200 },
        { value: 'on_hold', label: 'On Hold', sequence: 300 },
        { value: 'resolved', label: 'Resolved', sequence: 400 },
        { value: 'closed', label: 'Closed', sequence: 500 },
      ],
    }),
    caller_id: ReferenceColumn({
      label: 'Caller',
      reference: 'sys_user',
    }),
    assigned_to: ReferenceColumn({
      label: 'Assigned to',
      reference: 'sys_user',
    }),
    approver: ReferenceColumn({
      label: 'Approver',
      reference: 'sys_user',
    }),
    work_notes: JournalColumn({
      label: 'Work notes',
    }),
    ...(opts.extraColumns ?? {}),
  };

  return defineApp({
    scope: 'x_steward_itsm',
    name: 'Steward ITSM',
    version,
    vendor: 'Steward',
    description: 'IT Service Management dogfood scoped application built with @steward/sdk',
    roles: [
      Role({
        name: 'x_steward_itsm.agent',
        description: 'ITSM fulfiller role',
      }),
      Role({
        name: 'x_steward_itsm.manager',
        description: 'ITSM manager role',
        contains: ['x_steward_itsm.agent'],
      }),
    ],
    tables: [
      Table({
        name: 'x_steward_itsm_ticket',
        label: 'ITSM Ticket',
        extends: opts.extendsTable,
        numberPrefix: 'TKT',
        audit: true,
        schema,
        listLayout: ['number', 'short_description', 'priority', 'state', 'assigned_to', 'sys_updated_on'],
        formSections: [
          {
            caption: '',
            elements: ['number', 'short_description', 'priority', 'state', 'caller_id', 'assigned_to', 'approver', 'work_notes'],
          },
        ],
      }),
    ],
    acls: [
      Acl({
        name: 'x_steward_itsm_ticket',
        operation: 'read',
        roles: ['x_steward_itsm.agent'],
      }),
      Acl({
        name: 'x_steward_itsm_ticket',
        operation: 'create',
        roles: ['x_steward_itsm.agent'],
      }),
      Acl({
        name: 'x_steward_itsm_ticket',
        operation: 'write',
        roles: ['x_steward_itsm.agent'],
      }),
    ],
    scriptIncludes: [
      ScriptInclude({
        name: 'TicketSLAHelper',
        description: 'Scoped helper for ITSM ticket triage',
        script: `
          class TicketSLAHelper {
            static formatEscalationNote(num) {
              return 'Critical escalation triggered for ' + num;
            }
          }
          globalThis.TicketSLAHelper = TicketSLAHelper;
        `,
      }),
    ],
    businessRules: [
      BusinessRule({
        name: 'Triage Critical Ticket',
        table: 'x_steward_itsm_ticket',
        when: 'before',
        order: 100,
        actionInsert: true,
        actionUpdate: false,
        filterCondition: 'priority=1',
        script: `
          const note = TicketSLAHelper.formatEscalationNote(current.getValue('number'));
          gs.info(note);
        `,
      }),
    ],
    clientScripts: [
      ClientScript({
        name: 'Warn on P1 Priority',
        table: 'x_steward_itsm_ticket',
        type: 'onChange',
        fieldName: 'priority',
        order: 100,
        script: `
          function onChange(control, oldValue, newValue, isLoading) {
            if (isLoading) return;
            if (newValue === '1') {
              g_form.showFieldMsg('priority', 'P1 tickets require manager approval', 'info');
            }
          }
        `,
      }),
    ],
    uiPolicies: [
      UiPolicy({
        shortDescription: 'Require assigned_to when in_progress',
        table: 'x_steward_itsm_ticket',
        conditions: 'state=in_progress',
        actions: [
          {
            fieldName: 'assigned_to',
            mandatory: 'true',
            visible: 'true',
            disabled: 'leave',
          },
        ],
      }),
    ],
    emailNotifications: [
      EmailNotification({
        name: 'Ticket Resolved Notification',
        table: 'x_steward_itsm_ticket',
        whenToSend: 'record',
        actionInsert: false,
        actionUpdate: true,
        filterCondition: 'state=resolved',
        recipientFields: ['caller_id'],
        subject: 'Ticket ${number} has been resolved',
        messageText: 'Your ticket "${short_description}" (${number}) is now resolved.',
      }),
    ],
    flows: [
      Flow({
        name: 'P1 Ticket Approval and Notify',
        description: 'Requests manager approval on P1 tickets and notifies caller once approved',
        triggerType: 'record_created',
        table: 'x_steward_itsm_ticket',
        condition: 'priority=1',
        steps: [
          {
            id: 'request_approval',
            name: 'Ask Manager for Approval',
            type: 'ask_for_approval',
            approverField: 'approver',
            onRejectSteps: [
              {
                id: 'downgrade_on_reject',
                name: 'Downgrade priority on rejection',
                type: 'update_record',
                values: { priority: '3' },
              },
            ],
          },
          {
            id: 'mark_in_progress',
            name: 'Move Ticket to In Progress',
            type: 'update_record',
            values: { state: 'in_progress' },
          },
          {
            id: 'notify_caller',
            name: 'Notify Caller of P1 Approval',
            type: 'notify',
            recipientFields: ['caller_id'],
            subject: '[Approved] P1 Ticket ${number}: ${short_description}',
            body: 'Your P1 ticket ${number} (${short_description}) has been approved and is now In Progress.',
          },
        ],
      }),
    ],
    slas: [
      SlaDefinition({
        name: 'P1 Ticket Resolution SLA',
        table: 'x_steward_itsm_ticket',
        durationSeconds: 3600,
        startCondition: 'priority=1',
        pauseCondition: 'state=on_hold',
        stopCondition: 'stateINresolved,closed',
      }),
    ],
  });
}

export const itsmApp: AppPackage = createItsmApp();
export default itsmApp;
