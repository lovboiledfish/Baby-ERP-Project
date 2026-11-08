# Steward

A toy, from-scratch take on a **metadata-driven application platform** in the spirit of ServiceNow's Now Platform.
The core idea: **everything is a record**. Tables, fields and choices are rows in system tables (`sys_db_object`,
`sys_dictionary`, `sys_choice`), and inserting one of those rows *is* the schema change. Users, roles, groups and
ACLs are records too (`sys_user*`, `sys_security_acl`), and the data engine enforces them on every access.

Status: **Phase 0 + 1 + 2** (foundations, dictionary, data engine, Table API, identity and ACLs). See the design doc for the roadmap.

## Quick start (Windows, portable Node in `.tools/`)

```powershell
$env:Path = "$PWD\.tools\node;$env:Path"   # or use a system-wide Node >= 22
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run dev                              # http://127.0.0.1:3000, data in .data/instance
```

Environment: `PORT` (3000), `HOST` (127.0.0.1), `STEWARD_DATA_DIR` (`.data/instance`, or `memory`),
`STEWARD_ADMIN_PASSWORD` (password for `admin` while it has none; otherwise one is generated and printed once at boot).

Then open [`docs/api.http`](docs/api.http) in VS Code (REST Client) or any HTTP client.

## Layout

```
packages/
  shared/   encoded-query parser/serializer, zod metadata schemas
  kernel/   db adapter (PGlite), versioned bootstrap, meta service + hooks + schema compiler,
            data engine (query compiler, coercion, audit, numbering), GlideRecord, Instance,
            security (ACL evaluator, auth/sessions/impersonation, password hashing)
  server/   Fastify: /api/steward/auth, /api/now/table (Table API), /api/steward/meta (Meta API)
docs/
  adr/      architecture decision records
  api.http  manual walkthrough
```

## What works today

- Runtime-defined tables and fields, single-inheritance (`incident extends task`), **table-per-hierarchy storage**
  with automatic storage-column aliasing for sibling name clashes.
- Self-describing system tables; metadata edits flow through the same Record API (hooks perform DDL inside the
  same transaction - Postgres DDL is transactional, so a failed table definition leaves no trace).
- Record API: insert / update / delete / query with defaults, mandatory, type & choice validation,
  per-class auto-numbering (`INC0001000`), optimistic locking via `sys_mod_count`, field-level audit to `sys_audit`.
- ServiceNow encoded queries (`^`, `^OR`, `^NQ`, `LIKE`, `IN`, `ISEMPTY`, `INSTANCEOF`, `ORDERBY[DESC]`, ...)
  with **dot-walking** (`caller.department.name=IT`) compiled to LEFT JOINs.
- Table API compatible in spirit with `/api/now/table`: `sysparm_query`, `sysparm_fields` (dot-walk allowed),
  `sysparm_limit/offset`, `sysparm_display_value=true|all`, `X-Total-Count`, `ETag` / `If-Match`.
- Async `GlideRecord` (`addQuery`, `addOrCondition`, `addEncodedQuery`, `next`, `getDisplayValue`, `insert`, `update`, ...).
- **Identity:** users (scrypt-hashed `password` field type), groups, memberships, roles with containment, group roles.
- **Auth:** Basic or Bearer (`POST /api/steward/auth/login`, tokens stored hashed), `GET /me`, logout,
  admin/impersonator **impersonation** (audited). No anonymous API access.
- **ACLs** (`sys_security_acl` + `sys_security_acl_role`): table/field x read/write/create/delete, roles AND
  encoded-query condition (with `javascript:gs.getUserID()` / `getMyGroups()`), most-specific-level resolution,
  admin overrides, elevated `security_admin`. Enforced **inside the data engine** and compiled to SQL: row predicates,
  ACL-filtered dot-walk joins, per-field omission/masking, safe counts/paging. See ADR 0004.

## Not yet (by design, see roadmap)

UI (Phase 3), sandboxed scripting, business rules & script ACLs (Phase 4), events/jobs (Phase 5),
scoped apps + SDK (Phase 6), flows/SLA (Phase 7).
