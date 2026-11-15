import { z } from 'zod';
import { fieldSpecSchema, identifier, tableSpecSchema } from './meta-schemas';

export const scopeNameSchema = z
  .string()
  .regex(/^(global|x_[a-z0-9]+_[a-z0-9_]+)$/, 'Scope must be "global" or match "x_<vendor>_<app>" (lowercase alphanumeric/underscore)')
  .max(40);

export const appRoleSpecSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().optional(),
  elevatedPrivilege: z.boolean().optional(),
  contains: z.array(z.string().min(1)).optional(),
});

export const appFormSectionSpecSchema = z.object({
  caption: z.string().optional(),
  position: z.number().int().optional(),
  elements: z.array(z.string().min(1)),
});

export const appTableSpecSchema = tableSpecSchema.extend({
  listLayout: z.array(z.string().min(1)).optional(),
  formSections: z.array(appFormSectionSpecSchema).optional(),
  relatedLists: z.array(z.string().min(1)).optional(),
});

export const appFieldExtensionSpecSchema = fieldSpecSchema.extend({
  table: identifier,
});

export const appAclSpecSchema = z.object({
  key: z.string().min(1).optional(),
  name: z.string().min(1),
  operation: z.enum(['read', 'write', 'create', 'delete']),
  type: z.literal('record').optional(),
  adminOverrides: z.boolean().optional(),
  condition: z.string().optional(),
  script: z.string().optional(),
  description: z.string().optional(),
  active: z.boolean().optional(),
  roles: z.array(z.string().min(1)).optional(),
});

export const appBusinessRuleSpecSchema = z.object({
  name: z.string().min(1),
  table: identifier,
  when: z.enum(['before', 'after', 'async']),
  order: z.number().int().optional(),
  actionInsert: z.boolean().optional(),
  actionUpdate: z.boolean().optional(),
  actionDelete: z.boolean().optional(),
  filterCondition: z.string().optional(),
  condition: z.string().optional(),
  script: z.string().min(1),
  active: z.boolean().optional(),
});

export const appScriptIncludeSpecSchema = z.object({
  name: z.string().min(1),
  apiName: z.string().min(1).optional(),
  script: z.string().min(1),
  clientCallable: z.boolean().optional(),
  description: z.string().optional(),
  active: z.boolean().optional(),
});

export const appClientScriptSpecSchema = z.object({
  name: z.string().min(1),
  table: identifier,
  type: z.enum(['onLoad', 'onChange', 'onSubmit']),
  fieldName: z.string().optional(),
  order: z.number().int().optional(),
  script: z.string().min(1),
  active: z.boolean().optional(),
});

export const appUiPolicyActionSpecSchema = z.object({
  fieldName: z.string().min(1),
  mandatory: z.enum(['true', 'false', 'leave']).optional(),
  visible: z.enum(['true', 'false', 'leave']).optional(),
  disabled: z.enum(['true', 'false', 'leave']).optional(),
});

export const appUiPolicySpecSchema = z.object({
  shortDescription: z.string().min(1),
  table: identifier,
  conditions: z.string().optional(),
  onLoad: z.boolean().optional(),
  reverseIfFalse: z.boolean().optional(),
  order: z.number().int().optional(),
  active: z.boolean().optional(),
  actions: z.array(appUiPolicyActionSpecSchema).optional(),
});

export const appEmailNotificationSpecSchema = z.object({
  name: z.string().min(1),
  table: identifier,
  whenToSend: z.enum(['record', 'event']).optional(),
  actionInsert: z.boolean().optional(),
  actionUpdate: z.boolean().optional(),
  eventName: z.string().optional(),
  filterCondition: z.string().optional(),
  condition: z.string().optional(),
  recipientFields: z.array(z.string().min(1)).optional(),
  recipientUsers: z.array(z.string().min(1)).optional(),
  eventParm1: z.boolean().optional(),
  subject: z.string().min(1),
  messageText: z.string(),
  active: z.boolean().optional(),
});

export const appCrossScopePrivilegeSpecSchema = z.object({
  targetScope: scopeNameSchema.optional(),
  targetName: z.string().min(1),
  targetType: z.enum(['sys_db_object', 'sys_script_include']),
  operation: z.enum(['read', 'write', 'create', 'delete', 'execute']),
  status: z.enum(['allowed', 'requested', 'denied']).optional(),
});

export type FlowStepDef =
  | {
      id?: string;
      name?: string;
      type: 'update_record';
      table?: string;
      recordSysId?: string;
      values: Record<string, unknown>;
    }
  | {
      id?: string;
      name?: string;
      type: 'create_record';
      table: string;
      values: Record<string, unknown>;
    }
  | {
      id?: string;
      name?: string;
      type: 'log';
      level?: 'info' | 'warn' | 'error';
      message: string;
    }
  | {
      id?: string;
      name?: string;
      type: 'event';
      eventName: string;
      parm1?: string;
      parm2?: string;
    }
  | {
      id?: string;
      name?: string;
      type: 'notify';
      recipients?: string[];
      recipientFields?: string[];
      subject: string;
      body: string;
    }
  | {
      id?: string;
      name?: string;
      type: 'run_script';
      script: string;
    }
  | {
      id?: string;
      name?: string;
      type: 'if';
      condition: string;
      thenSteps: FlowStepDef[];
      elseSteps?: FlowStepDef[];
    }
  | {
      id?: string;
      name?: string;
      type: 'ask_for_approval';
      approver?: string;
      approverField?: string;
      dueInSeconds?: number;
      onRejectSteps?: FlowStepDef[];
    }
  | {
      id?: string;
      name?: string;
      type: 'wait_for_condition';
      condition: string;
    };

export const flowStepSchema: z.ZodType<FlowStepDef> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      id: z.string().optional(),
      name: z.string().optional(),
      type: z.literal('update_record'),
      table: z.string().optional(),
      recordSysId: z.string().optional(),
      values: z.record(z.string(), z.unknown()),
    }),
    z.object({
      id: z.string().optional(),
      name: z.string().optional(),
      type: z.literal('create_record'),
      table: z.string().min(1),
      values: z.record(z.string(), z.unknown()),
    }),
    z.object({
      id: z.string().optional(),
      name: z.string().optional(),
      type: z.literal('log'),
      level: z.enum(['info', 'warn', 'error']).optional(),
      message: z.string(),
    }),
    z.object({
      id: z.string().optional(),
      name: z.string().optional(),
      type: z.literal('event'),
      eventName: z.string().min(1),
      parm1: z.string().optional(),
      parm2: z.string().optional(),
    }),
    z.object({
      id: z.string().optional(),
      name: z.string().optional(),
      type: z.literal('notify'),
      recipients: z.array(z.string()).optional(),
      recipientFields: z.array(z.string()).optional(),
      subject: z.string().min(1),
      body: z.string(),
    }),
    z.object({
      id: z.string().optional(),
      name: z.string().optional(),
      type: z.literal('run_script'),
      script: z.string().min(1),
    }),
    z.object({
      id: z.string().optional(),
      name: z.string().optional(),
      type: z.literal('if'),
      condition: z.string().min(1),
      thenSteps: z.array(flowStepSchema),
      elseSteps: z.array(flowStepSchema).optional(),
    }),
    z.object({
      id: z.string().optional(),
      name: z.string().optional(),
      type: z.literal('ask_for_approval'),
      approver: z.string().optional(),
      approverField: z.string().optional(),
      dueInSeconds: z.number().int().positive().optional(),
      onRejectSteps: z.array(flowStepSchema).optional(),
    }),
    z.object({
      id: z.string().optional(),
      name: z.string().optional(),
      type: z.literal('wait_for_condition'),
      condition: z.string().min(1),
    }),
  ]),
);

export const appFlowSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  triggerType: z.enum(['record_created', 'record_updated', 'record_created_or_updated', 'event']),
  table: identifier.optional(),
  eventName: z.string().optional(),
  condition: z.string().optional(),
  runAs: z.enum(['system', 'initiating_user']).optional(),
  active: z.boolean().optional(),
  steps: z.array(flowStepSchema),
});

export const appSlaSpecSchema = z.object({
  name: z.string().min(1),
  table: identifier,
  durationSeconds: z.number().int().positive(),
  startCondition: z.string().min(1),
  pauseCondition: z.string().optional(),
  stopCondition: z.string().min(1),
  resetCondition: z.string().optional(),
  active: z.boolean().optional(),
});

export const appPackageSchema = z.object({
  scope: scopeNameSchema,
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(40),
  vendor: z.string().max(80).optional(),
  description: z.string().optional(),
  roles: z.array(appRoleSpecSchema).optional(),
  tables: z.array(appTableSpecSchema).optional(),
  fields: z.array(appFieldExtensionSpecSchema).optional(),
  acls: z.array(appAclSpecSchema).optional(),
  businessRules: z.array(appBusinessRuleSpecSchema).optional(),
  scriptIncludes: z.array(appScriptIncludeSpecSchema).optional(),
  clientScripts: z.array(appClientScriptSpecSchema).optional(),
  uiPolicies: z.array(appUiPolicySpecSchema).optional(),
  emailNotifications: z.array(appEmailNotificationSpecSchema).optional(),
  crossScopePrivileges: z.array(appCrossScopePrivilegeSpecSchema).optional(),
  flows: z.array(appFlowSpecSchema).optional(),
  slas: z.array(appSlaSpecSchema).optional(),
});

export type AppRoleSpec = z.infer<typeof appRoleSpecSchema>;
export type AppFormSectionSpec = z.infer<typeof appFormSectionSpecSchema>;
export type AppTableSpec = z.infer<typeof appTableSpecSchema>;
export type AppFieldExtensionSpec = z.infer<typeof appFieldExtensionSpecSchema>;
export type AppAclSpec = z.infer<typeof appAclSpecSchema>;
export type AppBusinessRuleSpec = z.infer<typeof appBusinessRuleSpecSchema>;
export type AppScriptIncludeSpec = z.infer<typeof appScriptIncludeSpecSchema>;
export type AppClientScriptSpec = z.infer<typeof appClientScriptSpecSchema>;
export type AppUiPolicyActionSpec = z.infer<typeof appUiPolicyActionSpecSchema>;
export type AppUiPolicySpec = z.infer<typeof appUiPolicySpecSchema>;
export type AppEmailNotificationSpec = z.infer<typeof appEmailNotificationSpecSchema>;
export type AppCrossScopePrivilegeSpec = z.infer<typeof appCrossScopePrivilegeSpecSchema>;
export type AppFlowSpec = z.infer<typeof appFlowSpecSchema>;
export type AppSlaSpec = z.infer<typeof appSlaSpecSchema>;
export type AppPackage = z.infer<typeof appPackageSchema>;
