import { parseEncodedQuery, type Condition, type QueryAst } from '@steward/shared';
import type { UiClientScript, UiField, UiPolicy } from '@steward/kernel';
import { toInputValue, type InputValue } from './values';

export type FormValues = Record<string, InputValue>;

export interface FieldUiMessage {
  type: 'info' | 'error';
  text: string;
}

export interface FieldUiState {
  mandatory: boolean;
  visible: boolean;
  readOnly: boolean;
  label: string;
  messages: FieldUiMessage[];
}

export interface FormBannerMessage {
  type: 'info' | 'error';
  text: string;
}

export interface FormClientState {
  values: FormValues;
  displays: Record<string, string>;
  fieldStates: Record<string, FieldUiState>;
  banners: FormBannerMessage[];
}

const MAX_ONCHANGE_DEPTH = 10;

function inputToString(val: InputValue | undefined): string {
  if (val === undefined || val === null) return '';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  return String(val);
}

function evalClientCondition(c: Condition, field: UiField | undefined, rawVal: InputValue | undefined): boolean {
  const strVal = inputToString(rawVal);
  const isEmpty = rawVal === undefined || rawVal === null || strVal === '';

  switch (c.operator) {
    case 'ISEMPTY':
      return isEmpty;
    case 'ISNOTEMPTY':
      return !isEmpty;
    case '=':
      if (c.value === '') return isEmpty;
      if (field?.type === 'boolean') {
        const b = c.value === 'true' || c.value === '1';
        return (rawVal === true || rawVal === 'true') === b;
      }
      if (field?.type === 'integer' || field?.type === 'decimal') {
        return !isEmpty && Number(strVal) === Number(c.value);
      }
      return strVal === c.value;
    case '!=':
      if (c.value === '') return !isEmpty;
      if (field?.type === 'boolean') {
        const b = c.value === 'true' || c.value === '1';
        return (rawVal === true || rawVal === 'true') !== b;
      }
      if (field?.type === 'integer' || field?.type === 'decimal') {
        return isEmpty || Number(strVal) !== Number(c.value);
      }
      return strVal !== c.value;
    case '<':
    case '<=':
    case '>':
    case '>=': {
      if (isEmpty) return false;
      if (field?.type === 'integer' || field?.type === 'decimal') {
        const a = Number(strVal);
        const b = Number(c.value);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
        if (c.operator === '<') return a < b;
        if (c.operator === '<=') return a <= b;
        if (c.operator === '>') return a > b;
        return a >= b;
      }
      if (c.operator === '<') return strVal < c.value;
      if (c.operator === '<=') return strVal <= c.value;
      if (c.operator === '>') return strVal > c.value;
      return strVal >= c.value;
    }
    case 'LIKE':
      return !isEmpty && strVal.toLowerCase().includes(c.value.toLowerCase());
    case 'NOT LIKE':
      return isEmpty || !strVal.toLowerCase().includes(c.value.toLowerCase());
    case 'STARTSWITH':
      return !isEmpty && strVal.toLowerCase().startsWith(c.value.toLowerCase());
    case 'ENDSWITH':
      return !isEmpty && strVal.toLowerCase().endsWith(c.value.toLowerCase());
    case 'IN': {
      if (isEmpty) return false;
      const items = c.value.split(',').map((s) => s.trim()).filter(Boolean);
      return items.includes(strVal);
    }
    case 'NOT IN': {
      if (isEmpty) return true;
      const items = c.value.split(',').map((s) => s.trim()).filter(Boolean);
      return !items.includes(strVal);
    }
    case 'INSTANCEOF':
      return strVal === c.value;
  }
}

/**
 * Evaluate an encoded query condition string against in-memory form `values`.
 */
export function matchesFormValues(
  conditions: string,
  fieldsByName: ReadonlyMap<string, UiField>,
  values: FormValues,
): boolean {
  if (!conditions || !conditions.trim()) return true;
  let ast: QueryAst;
  try {
    ast = parseEncodedQuery(conditions);
  } catch {
    return false;
  }
  if (ast.groups.length === 0) return true;

  for (const group of ast.groups) {
    let groupOk = true;
    for (const clause of group) {
      let clauseOk = false;
      for (const cond of clause) {
        const field = fieldsByName.get(cond.field);
        if (evalClientCondition(cond, field, values[cond.field])) {
          clauseOk = true;
          break;
        }
      }
      if (!clauseOk) {
        groupOk = false;
        break;
      }
    }
    if (groupOk) return true;
  }
  return false;
}

/** Build the baseline per-field UI state from dictionary metadata and server ACL decisions. */
export function buildInitialFieldStates(
  fields: readonly UiField[],
  canEdit: (field: UiField) => boolean,
): Record<string, FieldUiState> {
  const out: Record<string, FieldUiState> = {};
  for (const f of fields) {
    out[f.element] = {
      mandatory: f.mandatory,
      visible: true,
      readOnly: !canEdit(f),
      label: f.label,
      messages: [],
    };
  }
  return out;
}

/**
 * Apply declarative `UiPolicy` rules on top of the current form state.
 * Server ACL read-only restrictions (`!canEdit(field)`) are always preserved.
 */
export function applyUiPolicies(
  policies: readonly UiPolicy[],
  fieldsByName: ReadonlyMap<string, UiField>,
  canEdit: (field: UiField) => boolean,
  state: FormClientState,
  isInitialLoad: boolean,
): void {
  for (const policy of policies) {
    if (isInitialLoad && !policy.onLoad) continue;
    const matched = matchesFormValues(policy.conditions, fieldsByName, state.values);
    for (const action of policy.actions) {
      const field = fieldsByName.get(action.field);
      const fs = state.fieldStates[action.field];
      if (!field || !fs) continue;
      const aclWritable = canEdit(field);

      if (matched) {
        if (action.mandatory === 'true') fs.mandatory = true;
        else if (action.mandatory === 'false') fs.mandatory = false;

        if (action.visible === 'true') fs.visible = true;
        else if (action.visible === 'false') fs.visible = false;

        if (action.disabled === 'true') fs.readOnly = true;
        else if (action.disabled === 'false') fs.readOnly = !aclWritable;

        if (action.cleared) {
          state.values[action.field] = field.type === 'boolean' ? false : '';
          state.displays[action.field] = '';
        }
      } else if (policy.reverseIfFalse) {
        if (action.mandatory === 'true') fs.mandatory = false;
        else if (action.mandatory === 'false') fs.mandatory = true;

        if (action.visible === 'true') fs.visible = false;
        else if (action.visible === 'false') fs.visible = true;

        if (action.disabled === 'true') fs.readOnly = !aclWritable;
        else if (action.disabled === 'false') fs.readOnly = true;
      }
    }
  }
}

export interface GlideFormContext {
  table: string;
  sysId: string;
  isNew: boolean;
  fields: readonly UiField[];
  canEdit: (field: UiField) => boolean;
  clientScripts: readonly UiClientScript[];
  uiPolicies: readonly UiPolicy[];
  state: FormClientState;
}

/**
 * Execute a client script (`onLoad`, `onChange`, or `onSubmit`) against a `GlideForm` (`g_form`)
 * instance that mutates `ctx.state` in place.
 */
export function createGlideForm(ctx: GlideFormContext, onChangeDepth = 0) {
  const fieldsByName = new Map(ctx.fields.map((f) => [f.element, f]));

  const g_form = {
    getValue(fieldName: string): string {
      return inputToString(ctx.state.values[String(fieldName)]);
    },
    getBooleanValue(fieldName: string): boolean {
      const v = ctx.state.values[String(fieldName)];
      return v === true || v === 'true' || v === '1';
    },
    getIntValue(fieldName: string): number {
      const n = Number.parseInt(this.getValue(fieldName), 10);
      return Number.isFinite(n) ? n : 0;
    },
    getDecimalValue(fieldName: string): number {
      const n = Number.parseFloat(this.getValue(fieldName));
      return Number.isFinite(n) ? n : 0;
    },
    setValue(fieldName: string, value: unknown, displayValue?: string): void {
      const name = String(fieldName);
      const field = fieldsByName.get(name);
      if (!field) return;
      const oldStr = inputToString(ctx.state.values[name]);
      const nextInput = toInputValue(field.type, value === undefined ? null : value);
      const newStr = inputToString(nextInput);
      ctx.state.values[name] = nextInput;
      if (displayValue !== undefined) {
        ctx.state.displays[name] = String(displayValue);
      } else if (newStr === '') {
        ctx.state.displays[name] = '';
      }
      if (oldStr !== newStr && onChangeDepth < MAX_ONCHANGE_DEPTH) {
        applyUiPolicies(ctx.uiPolicies, fieldsByName, ctx.canEdit, ctx.state, false);
        runOnChangeScripts(ctx, name, oldStr, newStr, false, onChangeDepth + 1);
      }
    },
    clearValue(fieldName: string): void {
      const field = fieldsByName.get(String(fieldName));
      this.setValue(fieldName, field?.type === 'boolean' ? false : '', '');
    },
    setMandatory(fieldName: string, mandatory: boolean): void {
      const fs = ctx.state.fieldStates[String(fieldName)];
      if (fs) fs.mandatory = Boolean(mandatory);
    },
    isMandatory(fieldName: string): boolean {
      return Boolean(ctx.state.fieldStates[String(fieldName)]?.mandatory);
    },
    setReadOnly(fieldName: string, readOnly: boolean): void {
      const name = String(fieldName);
      const field = fieldsByName.get(name);
      const fs = ctx.state.fieldStates[name];
      if (!field || !fs) return;
      fs.readOnly = !ctx.canEdit(field) || Boolean(readOnly);
    },
    setDisabled(fieldName: string, disabled: boolean): void {
      this.setReadOnly(fieldName, disabled);
    },
    isReadOnly(fieldName: string): boolean {
      return Boolean(ctx.state.fieldStates[String(fieldName)]?.readOnly);
    },
    setDisplay(fieldName: string, visible: boolean): void {
      const fs = ctx.state.fieldStates[String(fieldName)];
      if (fs) fs.visible = Boolean(visible);
    },
    setVisible(fieldName: string, visible: boolean): void {
      this.setDisplay(fieldName, visible);
    },
    isVisible(fieldName: string): boolean {
      return ctx.state.fieldStates[String(fieldName)]?.visible !== false;
    },
    setLabelOf(fieldName: string, label: string): void {
      const fs = ctx.state.fieldStates[String(fieldName)];
      if (fs) fs.label = String(label ?? '');
    },
    getLabelOf(fieldName: string): string {
      return ctx.state.fieldStates[String(fieldName)]?.label ?? '';
    },
    showFieldMsg(fieldName: string, message: string, type: 'info' | 'error' = 'info'): void {
      const fs = ctx.state.fieldStates[String(fieldName)];
      if (fs) {
        fs.messages.push({ type: type === 'error' ? 'error' : 'info', text: String(message ?? '') });
      }
    },
    hideFieldMsg(fieldName: string): void {
      const fs = ctx.state.fieldStates[String(fieldName)];
      if (fs) fs.messages = [];
    },
    addInfoMessage(message: string): void {
      ctx.state.banners.push({ type: 'info', text: String(message ?? '') });
    },
    addErrorMessage(message: string): void {
      ctx.state.banners.push({ type: 'error', text: String(message ?? '') });
    },
    clearMessages(): void {
      ctx.state.banners = [];
    },
    isNewRecord(): boolean {
      return ctx.isNew;
    },
    getTableName(): string {
      return ctx.table;
    },
    getUniqueValue(): string {
      return ctx.isNew ? '' : ctx.sysId;
    },
  };

  return g_form;
}

function invokeScript(
  scriptSource: string,
  fnName: 'onLoad' | 'onChange' | 'onSubmit',
  g_form: ReturnType<typeof createGlideForm>,
  args: unknown[] = [],
): unknown {
  const runner = new Function(
    'g_form',
    'control',
    'oldValue',
    'newValue',
    'isLoading',
    'isTemplate',
    `${scriptSource}\n; if (typeof ${fnName} === 'function') { return ${fnName}(control, oldValue, newValue, isLoading, isTemplate); }`,
  );
  return runner(g_form, args[0], args[1], args[2], args[3], args[4]);
}

export function runOnLoadScripts(ctx: GlideFormContext): void {
  const fieldsByName = new Map(ctx.fields.map((f) => [f.element, f]));
  applyUiPolicies(ctx.uiPolicies, fieldsByName, ctx.canEdit, ctx.state, true);
  const g_form = createGlideForm(ctx, 0);
  for (const cs of ctx.clientScripts) {
    if (cs.type !== 'onLoad') continue;
    try {
      invokeScript(cs.script, 'onLoad', g_form, []);
    } catch (e) {
      ctx.state.banners.push({
        type: 'error',
        text: `Client script "${cs.name}" failed: ${(e as Error).message}`,
      });
    }
  }
}

export function runOnChangeScripts(
  ctx: GlideFormContext,
  fieldName: string,
  oldValue: string,
  newValue: string,
  isLoading = false,
  depth = 0,
): void {
  const fieldsByName = new Map(ctx.fields.map((f) => [f.element, f]));
  applyUiPolicies(ctx.uiPolicies, fieldsByName, ctx.canEdit, ctx.state, false);
  const g_form = createGlideForm(ctx, depth);
  for (const cs of ctx.clientScripts) {
    if (cs.type !== 'onChange' || cs.fieldName !== fieldName) continue;
    try {
      invokeScript(cs.script, 'onChange', g_form, [fieldName, oldValue, newValue, isLoading, false]);
    } catch (e) {
      ctx.state.banners.push({
        type: 'error',
        text: `Client script "${cs.name}" failed: ${(e as Error).message}`,
      });
    }
  }
}

/**
 * Run all `onSubmit` client scripts in order. Returns `false` if any script returns `false`.
 */
export function runOnSubmitScripts(ctx: GlideFormContext): boolean {
  const g_form = createGlideForm(ctx, 0);
  for (const cs of ctx.clientScripts) {
    if (cs.type !== 'onSubmit') continue;
    try {
      const res = invokeScript(cs.script, 'onSubmit', g_form, []);
      if (res === false) return false;
    } catch (e) {
      ctx.state.banners.push({
        type: 'error',
        text: `Client script "${cs.name}" failed: ${(e as Error).message}`,
      });
      return false;
    }
  }
  return true;
}

export function cloneFormClientState(state: FormClientState): FormClientState {
  const fieldStates: Record<string, FieldUiState> = {};
  for (const [k, v] of Object.entries(state.fieldStates)) {
    fieldStates[k] = { ...v, messages: [...v.messages] };
  }
  return {
    values: { ...state.values },
    displays: { ...state.displays },
    fieldStates,
    banners: [...state.banners],
  };
}
