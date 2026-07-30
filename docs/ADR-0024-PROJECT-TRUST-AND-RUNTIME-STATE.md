# ADR-0024: Trust projects before loading executable configuration

- **Status:** Superseded by ADR-0032
- **Date:** 2026-07-27

## Context

A repository can control provider commands, validation commands, editor commands, workspace roots, and state paths through `.atelier` configuration. Loading that configuration before a trust decision allowed opening a clone to execute repository-selected programs and redirect runtime state.

## Decision

At the time of this decision, Pi host trust and Atelier trust were intentionally distinct. Pi's built-in `/trust` controlled Pi-owned `.pi` resources, while Atelier used `/atelier-trust` (or `atlr trust ...`) for an external record that gated `.atelier` configuration and provider execution.

Atelier stored project and additional-workspace trust decisions outside the repository. Before trust, repository configuration was ignored, executable providers were replaced by non-executing providers, validation and editor launch were unavailable, and background indexing did not start. Project paths had to remain inside the trusted project. Durable runtime state and SQLite storage lived under the external Atelier state directory; `.atelier` contained only reviewable project documents.

`doctor` is observational: it reads configuration text for diagnostics without opening the ledger or starting providers.

## Consequences

- Cloned repositories cannot execute Atelier-configured programs merely by being opened.
- Multi-repository roots require separate approval.
- Trust is a local user decision and is not conveyed by committing files.
- Existing in-repository runtime databases are not treated as authoritative state.

## Supersession

Atelier 0.14.0-alpha.10 removed the Atelier trust database and `/atelier-trust`. The immutable startup workspace and recoverability policy in ADR-0032 now govern filesystem effects. Pi `/trust` remains independent.
