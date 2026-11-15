# ADR 0008: Scoped Applications, Pro-Code TypeScript SDK & Update Sets

- **Status:** Accepted (Phase 6)
- **Context:** Steward needs multi-application isolation (`sys_scope`), controlled cross-scope access (`sys_scope_privilege`), deterministic package installation/upgrade with customer customization protection (`sys_metadata_file` & `sys_update_set`), and a Pro-Code TypeScript SDK (`@steward/sdk`) for defining applications in code.

## Decisions

### 1. Application Scopes (`sys_scope`) and Physical Column Prefixing
- Every record in Steward carries `sys_scope` (defaulting to `'global'` or the owning table's scope).
- `TableMeta`, `FieldMeta`, `BusinessRule`, `ScriptInclude`, `FlowDefinition`, and `SlaDefinition` load their owning `scope` from `sys_scope`.
- When a scoped application `S` (`S !== 'global'`) adds a field to a table whose root physical table belongs to another scope (for example, extending `task` in `global`), `metadataHooks` automatically prefixes the Postgres storage column with `${S}_${element}` while exposing the clean logical field name `element` through the dictionary and query/write APIs.

### 2. Cross-Scope Runtime Guard (`sys_scope_privilege`)
- When a Business Rule, Script Include, or Flow executes in a non-`'global'` scope `S`, its `Session` carries `scope = S`.
- `DataEngine` checks `AppService.assertTableScopeAccess(session, table, operation)` on every read, count, insert, update, and delete:
  - A scoped session may always read/write/create/delete tables owned by its own scope `S`.
  - A scoped session may always read core lookup tables (`sys_user`, `sys_user_group`, `sys_user_role`, `sys_user_grmember`, `sys_choice`, `sys_journal_field`, `sys_scope`).
  - Any other cross-scope table access or cross-scope `ScriptInclude` execution (`include:load`) requires an active `sys_scope_privilege` record with `status = 'allowed'`; otherwise `ForbiddenError` is thrown.

### 3. Deterministic Package Deployment, Customization Protection & Update Sets
- `deterministicSysId(scope, table, artifactKey)` derives an RFC 4122 v5-formatted UUID from `sha256("steward:" + scope + ":" + table + ":" + artifactKey)`. Every artifact in an `AppPackage` maps to the same `sys_id` across instances and upgrades.
- `sys_metadata_file` tracks every deployed artifact along with its SHA-256 `checksum` and a `customer_modified` flag.
- When an administrator modifies a tracked metadata record outside of `deployPackage`, `AppService.captureMetadataChange` marks `sys_metadata_file.customer_modified = true` and records the change in `sys_update_xml` under the active `in_progress` `sys_update_set`.
- On subsequent `deployPackage` upgrades, any artifact with `customer_modified = true` is skipped (reported in `skippedCustomizations`) so customer customizations are never silently overwritten.
- `uninstallApp(scope)` removes active runtime artifacts (`sys_script`, `sys_script_include`, `sys_security_acl`, `sys_hub_flow`, `contract_sla`, etc.) and marks the scope's `sys_dictionary` rows and `sys_scope` `active = false`, while preserving physical tables and columns so customer data is never dropped.

### 4. Pro-Code TypeScript SDK (`@steward/sdk`)
- `@steward/sdk` provides a fluent TypeScript DSL (`defineApp`, `Table`, `*Column`, `Role`, `Acl`, `BusinessRule`, `ScriptInclude`, `ClientScript`, `UiPolicy`, `EmailNotification`, `CrossScopePrivilege`, `Flow`, `SlaDefinition`, `buildAppPackage`) and CLI (`build`, `deploy`, `types`), validated via shared Zod schemas (`@steward/shared`).
- `AppService.generateTypes(scope)` inspects the live dictionary and emits TypeScript `.d.ts` interfaces (`<Table>Record` and `StewardTableMap`) with literal union types for choice fields.
