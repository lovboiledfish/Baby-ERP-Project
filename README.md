# Steward

A toy, from-scratch take on a **metadata-driven application platform** in the spirit of ServiceNow's Now Platform.
The core idea: **everything is a record**. Tables, fields and choices are rows in system tables (`sys_db_object`,
`sys_dictionary`, `sys_choice`), and inserting one of those rows *is* the schema change. Users, roles, groups and
ACLs are records too (`sys_user*`, `sys_security_acl`), and the data engine enforces them on every access.

Status: **Phase 0 - 3** (foundations, dictionary, data engine, Table API, identity and ACLs, generated UI). See the design doc for the roadmap.

## Quick start (Windows, portable Node in `.tools/`)

```powershell
$env:Path = "$PWD\.tools\node;$env:Path"   # or use a system-wide Node >= 22
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run build                            # builds the web UI into packages/web/dist
npm.cmd run dev                              # http://127.0.0.1:3000/now/nav, data in .data/instance
```

Environment: `PORT` (3000), `HOST` (127.0.0.1), `STEWARD_DATA_DIR` (`.data/instance`, or `memory`),
`STEWARD_ADMIN_PASSWORD` (password for `admin` while it has none; otherwise one is generated and printed once at boot),
`STEWARD_WEB_ROOT` (serve a different web build; by default `packages/web/dist` is served when it exists).

For UI development, run `npm.cmd run dev` and `npm.cmd run dev:web` (Vite on http://127.0.0.1:5173, proxying `/api`).
Then open [`docs/api.http`](docs/api.http) in VS Code (REST Client) or any HTTP client for the APIs.

## Layout

```
packages/
  shared/   encoded-query parser/serializer, zod metadata schemas
  kernel/   db adapter (PGlite), versioned bootstrap, meta service + hooks + schema compiler,
            data engine (query compiler, coercion, audit, numbering, journal fields), GlideRecord, Instance,
            security (ACL evaluator, auth/sessions/impersonation, password hashing),
            ui (layouts, per-record field access, related lists, activity stream)
  server/   Fastify: /api/steward/auth, /api/now/table (Table API), /api/steward/meta (Meta API),
            /api/steward/ui (UI API), and the built web UI with SPA fallback
  web/      React 19 + Vite SPA: login, navigator, lists, condition builder, forms, reference picker,
            related lists, activity stream, table builder, list/form layout editors
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
- **Generated UI** (`@steward/web` + `/api/steward/ui`): login (HttpOnly cookie + CSRF header), navigator,
  lists with sorting, paging, breadcrumbs and a condition builder (`^`, `^OR`, `^NQ`), forms with type-ahead
  reference pickers, related lists (incoming references and `table.field=parent_field` relationships),
  `journal` fields (`sys_journal_field`) + merged activity stream, table builder, and editable list/form
  layouts (`sys_ui_list`, `sys_ui_form`, `sys_ui_section` with view fallback and inheritance). Per-record
  field ACL decisions drive read-only and hidden fields. See ADR 0005.

## Not yet (by design, see roadmap)

Sandboxed scripting, business rules & script ACLs (Phase 4), events/jobs (Phase 5),
scoped apps + SDK (Phase 6), flows/SLA (Phase 7).
