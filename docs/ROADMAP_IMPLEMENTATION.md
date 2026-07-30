# Roadmap Implementation — Atelier 0.14.0-alpha.10

The sixteen items in `docs/ROADMAP.md` were implemented as separate commits, in dependency order.

| Item | Commit | Result |
|---:|---|---|
| 1 | `feat(policy): adopt workspace recoverability model` | Immutable startup workspace, effect analysis, canonical boundary checks, VCS recoverability, checkpoints, and removal of Atelier trust setup. |
| 2 | `fix(process): isolate repository subprocess environments` | Minimal explicit environments for providers and validations. |
| 3 | `feat(data): redact and manage retained evidence` | Central redaction and evidence inspect/export/prune/delete lifecycle controls. |
| 4 | `refactor(process): make interactive providers cancellable` | Shared asynchronous runner with abort, timeout, process-group termination, and interactive provider migration. |
| 5 | `fix(beads): support the v2 JSON envelope` | Beads v2 envelope opt-in, legacy normalization, and version diagnostics. |
| 6 | `feat(pi): make footer ownership configurable` | Atelier, status-only, and disabled footer modes with bounded rendering. |
| 7 | `refactor(status): unify workflow presentation` | One typed status view rendered by CLI, Pi, footer, and Working State. |
| 8 | `feat(sandbox): add workspace-confined shell execution` | Seatbelt/Bubblewrap sandbox selection and typed `atlr_shell` execution. |
| 9 | `feat(workflow): resume cancelled approved tasks` | Source-baseline-checked task resumption without task recreation. |
| 10 | `feat(pi): add dedicated approval dialogs` | Scrollable exact-transaction and consequence approval surfaces. |
| 11 | `feat(code): improve retrieval ranking and presentation` | Definition-first grouping, snippets, and terminal-openable references. |
| 12 | `feat(workspace): support explicit multi-repository scope` | Explicit common workspace root and repository-qualified task paths and diagnostics. |
| 13 | `feat(ux): add repository navigation and diff surfaces` | File selection, editor open-at-line, Yazi/tree navigation, and integrated diff review. |
| 14 | `feat(plan): add guided execution-scope editing` | Canonical execution-contract editing with validation checks and readable authorization sections. |
| 15 | `refactor(context): make working state independent of compaction` | Deterministic digest-qualified authoritative context on every agent turn and compaction boundary. |
| 16 | `feat(service): add local Atelier core service` | Serialized local Core RPC service for shared provider reuse and non-Pi clients. |

The local service is the initial process boundary. Pi still retains a local Core fallback while the complete mutation protocol is moved behind RPC in a later release.
