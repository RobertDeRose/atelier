# ADR-0024: Trust projects before loading executable configuration

- **Status:** Accepted
- **Date:** 2026-07-27

## Context

A repository can control provider commands, validation commands, editor commands, workspace roots, and state paths through `.atelier` configuration. Loading that configuration before a trust decision allowed opening a clone to execute repository-selected programs and redirect runtime state.

## Decision

Atelier stores project and additional-workspace trust decisions outside the repository. Before trust, repository configuration is ignored, executable providers are replaced by non-executing providers, validation and editor launch are unavailable, and background indexing does not start. Project paths must remain inside the trusted project. Durable runtime state and SQLite storage live under the external Atelier state directory; `.atelier` contains only reviewable project documents.

`doctor` is observational: it reads configuration text for diagnostics without opening the ledger or starting providers.

## Consequences

- Cloned repositories cannot execute Atelier-configured programs merely by being opened.
- Multi-repository roots require separate approval.
- Trust is a local user decision and is not conveyed by committing files.
- Existing in-repository runtime databases are not treated as authoritative state.
