import {
  appPackageSchema,
  describeIssues,
  type AppAclSpec,
  type AppBusinessRuleSpec,
  type AppClientScriptSpec,
  type AppCrossScopePrivilegeSpec,
  type AppEmailNotificationSpec,
  type AppFieldExtensionSpec,
  type AppFlowSpec,
  type AppFormSectionSpec,
  type AppPackage,
  type AppRoleSpec,
  type AppScriptIncludeSpec,
  type AppSlaSpec,
  type AppTableSpec,
  type AppUiPolicySpec,
  type ChoiceSpec,
  type FieldSpec,
  type FlowStepDef,
} from '@steward/shared';

export type ColumnDef = Omit<FieldSpec, 'element'>;

export function StringColumn(opts: Omit<ColumnDef, 'type'> = {}): ColumnDef {
  return { type: 'string', ...opts };
}

export function TextColumn(opts: Omit<ColumnDef, 'type'> = {}): ColumnDef {
  return { type: 'text', ...opts };
}

export function IntegerColumn(opts: Omit<ColumnDef, 'type'> = {}): ColumnDef {
  return { type: 'integer', ...opts };
}

export function DecimalColumn(opts: Omit<ColumnDef, 'type'> = {}): ColumnDef {
  return { type: 'decimal', ...opts };
}

export function BooleanColumn(opts: Omit<ColumnDef, 'type'> = {}): ColumnDef {
  return { type: 'boolean', ...opts };
}

export function DateColumn(opts: Omit<ColumnDef, 'type'> = {}): ColumnDef {
  return { type: 'date', ...opts };
}

export function DateTimeColumn(opts: Omit<ColumnDef, 'type'> = {}): ColumnDef {
  return { type: 'datetime', ...opts };
}

export function ChoiceColumn(opts: Omit<ColumnDef, 'type' | 'choices'> & { choices: ChoiceSpec[] }): ColumnDef {
  return { type: 'choice', ...opts };
}

export function ReferenceColumn(opts: Omit<ColumnDef, 'type' | 'reference'> & { reference: string }): ColumnDef {
  return { type: 'reference', ...opts };
}

export function JournalColumn(opts: Omit<ColumnDef, 'type'> = {}): ColumnDef {
  return { type: 'journal', ...opts };
}

export function JsonColumn(opts: Omit<ColumnDef, 'type'> = {}): ColumnDef {
  return { type: 'json', ...opts };
}

export interface TableFluentSpec {
  name: string;
  label?: string;
  extends?: string;
  extendable?: boolean;
  numberPrefix?: string;
  audit?: boolean;
  schema: Record<string, ColumnDef>;
  listLayout?: string[];
  formSections?: AppFormSectionSpec[];
  relatedLists?: string[];
}

export function Table(spec: TableFluentSpec): AppTableSpec {
  const fields: FieldSpec[] = Object.entries(spec.schema).map(([element, col]) => ({
    element,
    ...col,
  }));
  return {
    name: spec.name,
    label: spec.label,
    extends: spec.extends,
    extendable: spec.extendable,
    numberPrefix: spec.numberPrefix,
    audit: spec.audit,
    fields,
    listLayout: spec.listLayout,
    formSections: spec.formSections,
    relatedLists: spec.relatedLists,
  };
}

export function FieldExtension(table: string, element: string, col: ColumnDef): AppFieldExtensionSpec {
  return {
    table,
    element,
    ...col,
  };
}

export function Role(spec: AppRoleSpec): AppRoleSpec {
  return { ...spec };
}

export function Acl(spec: AppAclSpec): AppAclSpec {
  return { ...spec };
}

export function serializeScript(scriptOrFn: string | ((...args: never[]) => unknown)): string {
  if (typeof scriptOrFn === 'string') return scriptOrFn;
  const raw = scriptOrFn.toString().trim();
  const openBrace = raw.indexOf('{');
  const closeBrace = raw.lastIndexOf('}');
  if (openBrace !== -1 && closeBrace > openBrace) {
    return raw.slice(openBrace + 1, closeBrace).trim();
  }
  return raw;
}

export function BusinessRule(
  spec: Omit<AppBusinessRuleSpec, 'script'> & { script: string | ((...args: never[]) => unknown) },
): AppBusinessRuleSpec {
  return {
    ...spec,
    script: serializeScript(spec.script),
  };
}

export function ScriptInclude(spec: AppScriptIncludeSpec): AppScriptIncludeSpec {
  return { ...spec };
}

export function ClientScript(spec: AppClientScriptSpec): AppClientScriptSpec {
  return { ...spec };
}

export function UiPolicy(spec: AppUiPolicySpec): AppUiPolicySpec {
  return { ...spec };
}

export function EmailNotification(spec: AppEmailNotificationSpec): AppEmailNotificationSpec {
  return { ...spec };
}

export function CrossScopePrivilege(spec: AppCrossScopePrivilegeSpec): AppCrossScopePrivilegeSpec {
  return { ...spec };
}

export function Flow(spec: AppFlowSpec): AppFlowSpec {
  return { ...spec };
}

export function SlaDefinition(spec: AppSlaSpec): AppSlaSpec {
  return { ...spec };
}

/**
 * Validate and define a Steward scoped application package using the Pro-Code TypeScript DSL.
 */
export function defineApp(pkg: AppPackage): AppPackage {
  const parsed = appPackageSchema.safeParse(pkg);
  if (!parsed.success) {
    throw new Error(`Invalid Steward app definition: ${describeIssues(parsed.error)}`);
  }
  return Object.freeze(parsed.data);
}

/**
 * Serialize a validated `AppPackage` into a deterministic JSON bundle.
 */
export function buildAppPackage(pkg: AppPackage): string {
  const validated = defineApp(pkg);
  return JSON.stringify(validated, null, 2);
}

export type {
  AppAclSpec,
  AppBusinessRuleSpec,
  AppClientScriptSpec,
  AppCrossScopePrivilegeSpec,
  AppEmailNotificationSpec,
  AppFieldExtensionSpec,
  AppFlowSpec,
  AppFormSectionSpec,
  AppPackage,
  AppRoleSpec,
  AppScriptIncludeSpec,
  AppSlaSpec,
  AppTableSpec,
  AppUiPolicySpec,
  FlowStepDef,
};
