# ADR 0004: ACLs are enforced inside the data engine and compiled to SQL

- Status: accepted
- Date: 2026-11-08

## Context
Phase 2 adds identity (users, groups, roles) and ServiceNow-style ACLs. The goal is that the same query returns
different rows and fields for different users, with no way around it for HTTP callers (and, in Phase 4, scripts).

## Decision
- **Where:** the `DataEngine` enforces ACLs for every read and write made with a *user* session. Sessions carry
  `system: true|false`. System sessions bypass ACLs, like server-side `GlideRecord` in ServiceNow (with a user session,
  our GlideRecord behaves like `GlideRecordSecure`). The HTTP layer only ever builds user sessions from real credentials.
- **Resolution** (`AclService`): most specific level wins. The table chain is `incident -> task -> *`. The field chain is
  `incident.f -> incident.* -> task.f -> task.* -> *.f -> *.*`. The first level that has any active rule for the
  operation decides, and a rule passes when roles AND condition pass. If no rule matches anywhere: table operations are
  denied (admin excepted) and field operations are allowed. Field `create` falls back to `write` rules.
- **Admin:** implicitly holds every role except *elevated* ones (`sys_user_role.elevated_privilege`, e.g. `security_admin`),
  and passes every rule with `admin_overrides=true`. ACL tables are guarded by `security_admin` rules with
  `admin_overrides=false`.
- **Reads are compiled, not post-filtered.** An ACL decision is `true | false | QueryAst[]` (allowed where any condition
  matches). The query compiler turns it into SQL:
  - base rows: `WHERE ... AND (<acl predicate on t0>)`
  - dot-walk joins: the target table's read predicate goes into the `LEFT JOIN ... ON`, so unreadable referenced rows
    look like NULL instead of leaking values
  - fields: denied means the column is omitted. Conditional means `CASE WHEN <predicate> THEN col END`.
  - filters and sorts on denied fields return 403. On conditional fields they become `(<predicate> AND <cond>)`, so a
    hidden value can't be probed with `=` / `!=`.
  - ACL conditions with dot-walks compile to a correlated `EXISTS` sub-query with private aliases, so they never share
    joins with the caller's query.
- **Writes:** table-level `create/write/delete` and field-level `create/write` for the fields the caller actually changes.
  Conditional rules are checked against the concrete row in SQL (`compileRowCheck`): the pre-image for update/delete, and
  the freshly inserted row for create, inside the same transaction so a failure rolls back. Unreadable records give 404,
  readable-but-denied gives 403.
- **Dynamic values:** until scripting exists, conditions (and user queries) support a fixed set of `javascript:` values:
  `gs.getUserID()`, `gs.getUserName()`, `getMyGroups()` / `gs.getUser().getMyGroups()`. Anything else is a 400.
- **Auth:** Basic (user:password) or Bearer tokens from `POST /api/steward/auth/login`. Only the SHA-256 of a token is
  stored (`sys_user_session`). Passwords use the new `password` field type: scrypt-hashed by the engine, and never
  selectable, queryable or audited in clear. Sessions are rebuilt from the DB on every request, so deactivation and role
  changes take effect immediately.

## Consequences
- Row filtering is as fast as the predicate SQL. Counts and paging stay correct because nothing is filtered after SQL.
- ACL conditions are limited to what encoded queries can express. Script ACLs arrive with the Phase 4 sandbox.
- Every request does a few small queries to build the session (roles, groups, containment). That's fine for a toy; a
  per-token cache with invalidation would be the next step.
- The ACL and metadata caches can briefly reflect uncommitted changes while a transaction is in flight (single
  connection). On rollback both are reloaded from committed state. A pooled Postgres adapter needs versioned snapshots (ADR 0002).
