# Legacy Decision Record 0016 — Normalize SQLite missing rows at the runtime boundary

- **Status:** Accepted
- **Date:** 2026-07-25

## Context

ADR-0015 introduced a dual-runtime SQLite boundary: Pi uses `bun:sqlite`, while Node consumers use
`node:sqlite`. A real launch then exposed a semantic mismatch not represented by the shared TypeScript
interface. When a prepared `SELECT` has no matching row, Bun returns `null`; Node returns `undefined`.

A fresh Atelier repository has no durable state records. The first state read therefore attempted to
access `value_json` on Bun's `null` result and prevented the Pi shell from starting.

## Decision

Atelier will define the provider-neutral `SqliteStatement.get()` contract as follows:

- a matching row is returned as an object;
- no matching row is returned as `undefined`;
- the Bun adapter converts native `null` to `undefined`;
- ledger lookup methods remain defensively null-safe.

The normalization belongs at the SQLite runtime boundary so all current and future ledger consumers
observe the same behavior.

## Consequences

- A fresh Pi session can read empty durable state without crashing.
- Node and Bun share one missing-row semantic contract.
- Existing databases require no migration or cleanup.
- Callers do not need runtime-specific null checks.
- The small synchronous SQLite abstraction remains sufficient for the current shell architecture.
