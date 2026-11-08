# ADR 0002: Single-tenant instances on Postgres, embedded PGlite for dev/test

- Status: accepted
- Date: 2026-11-08

## Context
ServiceNow runs one instance (and one database) per customer. We need fast, dependency-free tests and a dev
loop that works on a machine without Docker.

## Decision
- One Steward instance = one Postgres database. No tenant columns anywhere.
- The kernel talks to a small `Db` port (`query`, `exec`, `transaction`). Today it's implemented by **PGlite**
  (Postgres compiled to WASM, in-process; in-memory for tests, on-disk for dev). A `node-postgres` adapter
  can implement the same port for "real" deployments.
- The PGlite adapter serializes top-level work with a mutex so transactions never interleave.

## Consequences
- `npm test` needs nothing but Node. Each test file boots a fresh in-memory instance in roughly 0.5 s.
- PGlite is single-connection, so there's no real concurrency yet. The metadata cache may briefly observe uncommitted
  metadata from an in-flight transaction. A pooled Postgres adapter will need snapshot-versioned metadata.
