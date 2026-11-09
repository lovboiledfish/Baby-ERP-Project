export { Instance, type InstanceOptions } from './instance';
export type { Db, QueryResult, Row } from './db/db';
export { PgliteDb } from './db/pglite';
export {
  DataEngine,
  type DeleteOptions,
  type DisplayMode,
  type InsertOptions,
  type QueryOptions,
  type RecordValues,
  type UpdateOptions,
} from './data/data-engine';
export { GlideRecord, QueryCondition } from './data/glide-record';
export { HookRegistry, type HookContext, type Operation, type SystemHook } from './data/hooks';
export { compileCount, compileRowCheck, compileSelect, type CompiledQuery, type SelectSpec } from './data/query-compiler';
export { MetaService } from './meta/meta-service';
export { MetaApi, describeTable, type FieldDescription, type TableDescription } from './meta/meta-api';
export { planDDL, pgType, type DictionaryChange } from './meta/schema-compiler';
export type { ChoiceMeta, FieldMeta, TableMeta } from './meta/types';
export { BOOTSTRAP_VERSION, SYSTEM_TABLES, bootstrap, bootstrapVersion } from './bootstrap/system-tables';
export { AclService, ADMIN_ROLE, parseAclName, type AclRule } from './security/acl-service';
export { AuthService, IMPERSONATOR_ROLE, type AuthOptions, type LoginResult } from './security/auth-service';
export { DYNAMIC_VALUES, resolveDynamic } from './security/dynamic';
export { hashPassword, isPasswordHash, verifyPassword } from './security/password';
export {
  ACL_OPERATIONS,
  isScriptedAccess,
  type AccessDecision,
  type AclOperation,
  type ReadAccess,
  type ScriptedAccess,
  type ScriptedAccessClause,
} from './security/types';
export {
  ScriptRuntime,
  checkScriptSyntax,
  type ScriptExecRequest,
  type ScriptExecResult,
  type ScriptLogEntry,
  type ScriptMessage,
  type ScriptRecordBinding,
  type ScriptRuntimeOptions,
} from './script/sandbox';
export { ScriptService, type BusinessRule, type RuleWhen, type ScriptInclude } from './script/script-service';
export { matchesRecord } from './script/match-record';
export {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  StewardError,
  UnauthorizedError,
  ValidationError,
  toStewardError,
} from './errors';
export { SYSTEM_SESSION, scriptSession, systemSession, type Session } from './session';
export {
  UiService,
  type ActivityEntry,
  type FormAccess,
  type FormLayout,
  type FormSection,
  type ListLayout,
  type RelatedList,
  type UiColumn,
  type UiField,
  type UiTable,
} from './ui/ui-service';
export { parseElements, parseRelated, resolvePath } from './ui/layout';
