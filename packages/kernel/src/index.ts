export { Instance, type InstanceOptions } from './instance';
export type { Db, QueryResult, Row } from './db/db';
export { PgliteDb } from './db/pglite';
export { DataEngine, type DisplayMode, type QueryOptions, type RecordValues, type UpdateOptions } from './data/data-engine';
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
export { ACL_OPERATIONS, type AccessDecision, type AclOperation, type ReadAccess } from './security/types';
export {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  StewardError,
  UnauthorizedError,
  ValidationError,
  toStewardError,
} from './errors';
export { SYSTEM_SESSION, systemSession, type Session } from './session';
