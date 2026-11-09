# ADR 0005: The generated UI

Status: accepted (Phase 3)

## Context

Phase 3 asks for login, a navigator, lists with a condition builder, forms, reference pickers,
related lists and a journal/activity stream, all generated from metadata, so that an admin can
define a table in the UI and immediately use its list and form. Field-level ACL decisions must
drive what the UI shows and lets you edit.

## Decision

1. **Layouts are records.** `sys_ui_list` (table, view, comma-separated columns, dot-walks allowed),
   `sys_ui_form` (table, view, optional related lists) and `sys_ui_section` (form, caption, position,
   comma-separated fields). This is simpler than ServiceNow's element tables (`sys_ui_list_element`,
   `sys_ui_element`, `sys_ui_form_section`) but keeps the important behaviour: views with fallback to
   `default`, inheritance from parent tables, and validation hooks so the renderer can trust the
   stored layout. Without a layout record, lists and forms are generated from the dictionary.
2. **The server decides, the client renders.** `/api/steward/ui/*` returns layouts already filtered by
   the caller's read ACLs, plus per-field write decisions evaluated against the concrete record
   (conditional ACLs included). Conditionally readable fields that fail on a record are removed from
   that record's form. The data engine still enforces everything on save; the UI decisions only
   avoid offering what would be rejected.
3. **Journal fields** (`journal` type) keep an always-empty column. A non-blank value written to one
   becomes a `sys_journal_field` row in the same transaction; a journal-only update still bumps
   `sys_mod_count`. The activity stream merges journal entries and `sys_audit` rows and filters them
   by the caller's field read ACLs on that record. Password values never appear.
4. **Related lists** default to every incoming reference to the table (or an ancestor), plus built-in
   value relationships (`sys_db_object` → `sys_dictionary.name=name`, `sys_choice.name=name`), and
   can be pinned per form with `table.field` or `table.field=parent_field` entries.
5. **Web sessions use an HttpOnly, SameSite=Strict cookie** (`POST /login` with `session: "cookie"`), so
   page scripts never see the token. Cookie-authenticated requests with unsafe methods must carry
   `X-Steward-CSRF`; a cross-site page cannot add that header without a CORS preflight, which this
   server never approves. Bearer/Basic API clients are unaffected.
6. **No router or data-fetching library.** The SPA is React 19 + Vite with a ~60-line history router
   (ServiceNow URLs: `/now/nav`, `/<table>_list.do`, `/<table>.do`) and a small `useAsync` hook.
   Fastify serves the built `dist/` with an SPA fallback, a strict CSP and path-traversal checks.

## Consequences

- Layout edits by admins take effect on the next request: no build step, no cache.
- Multi-step layout saves from the UI (form + sections) are not atomic; a failure can leave a
  partially saved layout that the admin can fix and save again.
- The UI is verified by a jsdom test that renders the real SPA against the real server; it is not
  yet exercised in a real browser by automated tests (Playwright is a later addition).
