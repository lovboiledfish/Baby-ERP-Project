# ADR 0003: Hand-rolled query compiler instead of an ORM

- Status: accepted
- Date: 2026-11-08

## Context
The design doc suggested Kysely. But the schema only exists at runtime (in `sys_dictionary`), so static ORMs
(Prisma, Drizzle) don't fit, and a typed query builder adds little when every identifier is dynamic anyway.

## Decision
Compile the encoded-query AST directly to parameterized SQL in `kernel/src/data/query-compiler.ts`:
- identifiers come only from metadata and are validated (`quoteIdent` allows `[a-z_][a-z0-9_]*` only);
- every value is a bind parameter;
- dot-walks become `LEFT JOIN`s with reused aliases per path prefix.

## Consequences
- About 250 lines we fully control, which will matter for ACL predicate injection in Phase 2.
- We own SQL correctness. This is covered by integration tests against real Postgres (PGlite).
