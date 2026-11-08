# ADR 0001: Table-per-hierarchy storage

- Status: accepted
- Date: 2026-11-08

## Context
Tables are defined at runtime and support single inheritance (`incident extends task`). A query on `task`
must return incidents, problems and plain tasks; a query on `incident` must return only incidents.

## Decision
Only root tables get a physical Postgres table. A child table's fields become columns on the root's physical
table, and every row carries a `sys_class_name` discriminator. Queries on a non-root table add
`sys_class_name IN (<table and descendants>)`. Sibling tables that reuse an element name with a different
meaning get an aliased storage column (`problem_category`), recorded in `sys_dictionary.column_name`.

## Consequences
- Polymorphic queries are a single-table scan/index lookup, with no UNION or JOIN. This matches ServiceNow's `task` flattening.
- Adding a field is an `ALTER TABLE ... ADD COLUMN` (cheap in Postgres for nullable columns, and transactional).
- Wide, sparse root tables. Acceptable for a toy; revisit (e.g. table-per-class for very large hierarchies) if needed.
- Reference columns are indexed `uuid`s **without** FK constraints, so cross-app installs/uninstalls stay simple. Referential
  cleanup becomes a platform feature later.
