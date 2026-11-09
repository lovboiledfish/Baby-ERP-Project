# ADR 0006: Sandboxed server scripting

Status: accepted (Phase 4)

## Context

Phase 4 introduces Business Rules (`sys_script`), Script Includes (`sys_script_include`), scripted ACLs
(`sys_security_acl.script`), and ad-hoc background scripts (`Scripts - Background`). In ServiceNow,
customer scripts are written in synchronous JavaScript (`var gr = new GlideRecord('task'); gr.query(); while (gr.next()) { ... }`),
while our Node.js data engine and PGlite database driver are asynchronous. At the same time, scripts are
data stored in database rows: a runaway `while (true) {}` or memory allocation bomb must be terminated
at a resource boundary without crashing the Node process or leaving a transaction half-committed, and a
non-`security_admin` script must not be able to escalate privileges.

## Decision

1. **V8 isolate pool (`isolated-vm`) with synchronous host bridge (`applySyncPromise`).** Each script
   invocation acquires an `ivm.Isolate` from a bounded pool (`memoryLimit: 64 MB`, wall-clock + CPU
   `timeout: 1500 ms` for rules / `5000 ms` for background scripts, `maxHostCalls: 250`). Inside the
   isolate, `GlideRecord`, `GlideRecordSecure`, `gs`, `GlideDateTime`, and `Class.create()` are
   synchronous wrappers around a single `ivm.Reference` host callback invoked via `applySyncPromise`.
   Why a pool of isolates instead of a single shared isolate? While an isolate is paused inside
   `applySyncPromise` awaiting a host `DataEngine` promise (e.g. `gr.insert()`), V8 locks that isolate;
   if the host operation triggers a nested Business Rule or scripted ACL, acquiring a fresh isolate from
   the pool avoids re-entering the locked isolate and deadlocking. Disposed or out-of-memory isolates
   are discarded and replaced transparently.
2. **In-isolate Proxy for `current`, `previous`, and `GlideRecord` rows.** Scripts read and mutate fields
   either through `gr.getValue('priority')` / `gr.setValue('priority', 1)` or directly as properties
   (`current.priority = 1`). Before a `before` Business Rule returns, the runner serializes `pending`
   field mutations back to the host, which merges them into the in-flight write values (`DataEngine`)
   or aborts the operation with `RuleAbortError` (`400`) if `current.setAbortAction(true)` was called.
3. **Rule pipeline, savepoints, and recursion guard.**
   - Rules on a target table inherit across the table hierarchy (`task` rules run on `incident` writes)
     and execute in ascending `order`.
   - Each rule checks `filter_condition` (encoded query evaluated against `current` with dot-walking via
     `matchesRecord`) and `condition` (JS expression) before running `script`.
   - `before` rules run before validation/persistence and may mutate `current` or abort.
   - `after` rules run inside the same outer transaction after the row and `sys_audit`/`sys_journal_field`
     entries are written. Every host database write is wrapped in a Postgres `SAVEPOINT` (`PgliteTx`),
     so if a script catches a failed `gr.insert()` or an `after` rule throws, any failed nested SQL
     statement rolls back cleanly without poisoning the outer transaction.
   - `async` rules are queued after the outer transaction commits; `Instance.scripts.flush()` awaits all
     in-flight async tasks for deterministic testing and graceful shutdown.
   - `gr.setWorkflow(false)` (or `{ workflow: false }` on `DataEngine`) suppresses Business Rules on that
     write. Hook/rule nesting is capped at `MAX_HOOK_DEPTH = 16`.
4. **Scripted ACLs (`sys_security_acl.script`).** When the decisive ACL level for a table/field operation
   contains at least one rule with a non-empty `script`, `AclService` returns a `ScriptedAccess` descriptor
   (including pre-compiled `sqlConditions` when every clause also has a static encoded-query condition).
   `DataEngine` pushes down `sqlConditions` to SQL when possible and evaluates the script in read-only mode
   (`readOnly: true`, where host write operations throw) with `current` bound to the candidate row. A rule
   grants access when `answer !== false` (or the final expression is truthy when `answer` is unset). Syntax
   errors, runtime errors, and timeouts fail closed (`false`).
5. **Privilege boundary (`session.script`).** Server-side `GlideRecord` inside scripts runs with
   `scriptSession(caller, keepRoles)` (`system: true, script: true`). Normal table/field ACLs are bypassed
   (`system: true`, whereas `GlideRecordSecure` uses the caller's session and enforces ACLs), but
   `elevatedRoleGuards()` and `sys_security_acl` / `sys_user_session` write hooks check
   `session.system && !session.script`. Furthermore, Business Rules strip elevated roles (`keepRoles = false`),
   so a Business Rule authored by an ordinary `admin` cannot grant `security_admin` or modify ACLs even
   when triggered by a `security_admin` user.

## Consequences

- Synchronous ServiceNow-style server scripts (`GlideRecord`, `Class.create`, `gs.*`) work unmodified
  against the async PGlite engine, with strict CPU, memory, and host-call limits.
- Rows governed by scripted read ACLs must be post-filtered by the engine when the script cannot be
  expressed purely as an encoded query; static encoded-query conditions alongside scripts are still
  pushed down to SQL.
