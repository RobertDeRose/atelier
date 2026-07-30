# Review Corrections — Atelier 0.14.0-alpha.10

This document maps each recommendation from the critical review of commit `286e2bc14edb` to the
0.14.0-alpha.10 implementation. The release remains a trusted-repository alpha. “Corrected” means the
specific unsound claim or behavior was removed, constrained, or made fail-closed; it does not mean that
Atelier now supplies an operating-system sandbox.

## Recommendation 1 — Default generic shell to approval-required

**Status:** Corrected.

Pi marks generic shell as `boundary: "unconfined"` and authorizes every call as `command.execute`.
Unconfined commands cannot inherit task capability grants and require a one-operation permission. The
command classifier supplies risk diagnostics only; it can no longer turn arbitrary shell into a read or
bypass execution evidence.

**Implementation:** `apps/pi-extension/src/index.ts`, `packages/core/src/policy/policy-engine.ts`,
`packages/core/src/policy/action-classifier.ts`.

**Verification:** adversarial command corpus in `tests/security-boundary.test.ts`.

## Recommendation 2 — Add external project trust

**Status:** Corrected.

Trust records are stored outside the repository. Repository configuration is ignored until the canonical
root has an external trust record.

**Implementation:** `packages/core/src/security/project-trust.ts`, `atlr trust ...`.

**Verification:** untrusted-open and external-trust tests in `tests/security-boundary.test.ts`.

## Recommendation 3 — Start no executable integration before trust

**Status:** Corrected.

Before trust, Atelier uses non-executing repository/task/code providers and refuses editor, validation,
retrieval, and workflow operations that require trusted project data. Automatic Pi indexing starts only
after trust.

**Implementation:** `packages/core/src/core.ts`, `packages/core/src/config/config.ts`,
`packages/core/src/repository/directory-repository-provider.ts`, `apps/pi-extension/src/index.ts`.

**Verification:** malicious provider marker regression in `tests/security-boundary.test.ts`.

## Recommendation 4 — Use symlink-safe real-path confinement

**Status:** Corrected for typed file operations.

Existing targets are canonicalized with `realpath`; new targets resolve through the nearest existing
ancestor. Symlink escapes are rejected. Authorization requests carry resolved typed paths.

**Implementation:** `packages/core/src/security/path-boundary.ts`, `packages/core/src/core.ts`,
`apps/pi-extension/src/index.ts`.

**Verification:** existing and not-yet-created symlink escape cases in `tests/security-boundary.test.ts`.

## Recommendation 5 — Treat shell as unconfined unless sandboxed

**Status:** Corrected by fail-closed authorization; no sandbox is claimed.

The model distinguishes `typed`, `sandboxed`, and `unconfined` boundaries. Current generic shell is
unconfined and individually approved. A future OS sandbox can use the sandboxed boundary, but this release
does not represent shell as repository-confined.

**Implementation:** `ExecutionBoundary` in `packages/core/src/domain/types.ts` and policy matching in
`packages/core/src/policy/policy-engine.ts`.

## Recommendation 6 — Add adversarial classifier and path tests

**Status:** Corrected.

The regression corpus covers wrappers, long-form in-place options, VCS reference creation, Jujutsu file
mutation, process substitution, command-execution flags, output files, nested `find -exec`, and symlink
escapes.

**Verification:** `tests/security-boundary.test.ts` and `tests/action-classifier.test.ts`.

## Recommendation 7 — Use a narrow task capability bundle

**Status:** Corrected.

Every executable task now includes a machine-readable execution contract. Exact approval derives and
hashes only its reviewed paths, named validations, optional dependency/full-suite authority, optional
path-scoped local change, and closure capability. The approval surface displays the projection before
mutation. Generic shell and typed operations without a reachable model/UI tool are excluded. Capability
integrity is rechecked during resume.

**Implementation:** `packages/core/src/planning/task-execution-scope.ts`,
`packages/core/src/workflow/execution-baseline.ts`,
`packages/core/src/workflow/execution-workflow-coordinator.ts`, `packages/core/src/ledger/sqlite-ledger.ts`,
and `packages/core/src/workflow/capability-summary.ts`.

**Verification:** `tests/manual-acceptance-corrections.test.ts`, execution workflow tests, and acceptance
tests prove narrow derivation, visible disclosure, atomic installation, and fail-closed resume.

## Recommendation 8 — Make the Pi prompt truthful

**Status:** Corrected.

The injected prompt distinguishes typed task capabilities from unconfined shell approval, describes
provider-first retrieval as advisory, states that authorization does not override the user's latest
constraints, and directs declared model validation through `atlr_validate` rather than Bash.

**Implementation:** `apps/pi-extension/src/index.ts`.

**Verification:** `tests/pi-extension.test.ts`.

## Recommendation 9 — Snapshot every workspace repository

**Status:** Corrected.

Each workspace root receives a repository provider and real source snapshot. Secondary roots require an
external workspace-root approval.

**Implementation:** `packages/core/src/code/workspace.ts`, `packages/core/src/core.ts`,
`packages/core/src/security/project-trust.ts`.

**Verification:** `tests/multi-repository-correctness.test.ts`.

## Recommendation 10 — Bind approval to source and retrieval baselines

**Status:** Corrected.

Plan approval records the primary source snapshot, all repository revision bindings, and retrieval
provider/index bindings. Raw VCS identity remains diagnostic, while a source base/fingerprint excludes
Atelier, Beads, and provider metadata. Preparation and resume revalidate source bindings. Secondary source
drift invalidates execution; primary source drift is accepted only as observable task work with a
reachable approved baseline.

**Implementation:** `packages/core/src/repository/revision-binding.ts`,
`packages/core/src/workflow/execution-baseline.ts`, `ExecutionWorkflowCoordinator`.

**Verification:** multi-repository drift and execution-resume tests.

## Recommendation 11 — Replace the completion reminder with one predicate

**Status:** Corrected.

`taskClosureReadiness()` is authoritative for CLI, Pi, Working State, and task closure. It evaluates
current required validation, exact final-diff review, local commit/change creation, and configured clean
state. `repo review-diff` displays and hashes the exact baseline diff before recording review; a changed
hash is rejected. The predicate blocks closure only: an incomplete task can remain active and idle, and
`agent_settled` emits a passive deduplicated notice instead of scheduling another model turn.

**Implementation:** `packages/core/src/core.ts`, `packages/core/src/validation/validation-service.ts`.

**Verification:** `tests/execution-evidence.test.ts`, acceptance tests, and CLI tests.

## Recommendation 12 — Require at least one required validation

**Status:** Corrected.

When closure requires validation, both configuration validation and task closure fail if no applicable
validation is marked `required: true`. Readiness distinguishes an absent focused selection, a selection
that matches no required check, and missing required configuration.

**Implementation:** `AtelierCore.validateConfiguration()` and `ValidationService.closureReadiness()`.

**Verification:** `tests/retrieval-config.test.ts` and `tests/validation-service.test.ts`.

## Recommendation 13 — Enforce or remove validation `approval`

**Status:** Corrected by removal.

`approval` is not part of `ValidationDefinition`; manifests containing it are rejected. Authorization is
owned by policy and typed capabilities rather than executable repository metadata.

**Verification:** `tests/security-boundary.test.ts`.

## Recommendation 14 — Remove incomplete turn/session grants

**Status:** Corrected.

Public grant scopes are now `operation`, `task`, and `repository`. Schema migration 7 revokes legacy
`turn` and `session` rows.

**Implementation:** domain types and `SqliteLedger.migrate()`.

**Verification:** legacy-scope migration regression in `tests/security-boundary.test.ts`.

## Recommendation 15 — Make provider observation failure explicit

**Status:** Corrected.

Git and Jujutsu observations throw `RepositoryObservationError` with command, cwd, and status details.
Failures no longer become empty changed-path or diff results.

**Implementation:** both repository providers and `packages/core/src/domain/errors.ts`.

**Verification:** `tests/repository-provider-correctness.test.ts` and Jujutsu provider tests.

## Recommendation 16 — Include staged Git changes

**Status:** Corrected.

`diff()` returns labeled staged and unstaged sections. Baseline diffs include staged/working-tree state and
untracked source files.

**Verification:** `tests/repository-provider-correctness.test.ts`.

## Recommendation 17 — Make Pi state session-local and shutdown asynchronous

**Status:** Corrected.

The extension stores state per session/context rather than in one active global Core. Replacement and
shutdown await code-provider disposal before closing SQLite.

**Implementation:** `apps/pi-extension/src/index.ts`, `AtelierCore.close()`.

**Verification:** concurrent-session and shutdown regressions in `tests/pi-extension.test.ts`.

## Recommendation 18 — Separate project configuration from runtime state

**Status:** Corrected.

Trackable project files remain under `.atelier`; the ledger and runtime state live under the user state
home keyed by canonical repository root. Repository configuration cannot redirect runtime paths. The
blanket `.atelier/` ignore was removed.

**Implementation:** `packages/core/src/config/config.ts`, `.gitignore`, ADR-0024.

## Recommendation 19 — Make doctor observational

**Status:** Corrected.

`atlr doctor` uses configuration/trust inspection only. It does not create runtime directories or a
ledger and does not start configured providers.

**Verification:** doctor marker and filesystem regression in `tests/security-boundary.test.ts`.

## Recommendation 20 — Reduce concentration in central modules

**Status:** Corrected by cohesive decomposition without rewriting persistence semantics.

The previously concentrated entry points now delegate to focused modules: ledger migrations live in
`ledger/schema.ts`, Working State Markdown rendering in `state/working-state-markdown.ts`, retrieval
normalization and budget helpers in `code/service-support.ts`, CLI parsing and command handlers in
`apps/cli/src/arguments.ts` and `apps/cli/src/command-handlers.ts`, and Pi authorization in
`apps/pi-extension/src/tool-authorization.ts`. Pi state remains session-owned.

**Verification:** `scripts/check-release-metadata.ts` enforces the extracted module boundaries and
generous line-count ceilings so the orchestration entry points cannot silently reconcentrate.

## Recommendation 21 — Break the domain/code dependency cycle

**Status:** Corrected.

Provider-neutral code identity and retrieval-state types moved into the domain layer. Domain files no
longer import from `../code/`.

**Verification:** `scripts/check-release-metadata.ts` enforces the boundary.

## Recommendation 22 — Add pinned deterministic CI

**Status:** Corrected.

CI uses Node 24.18.0, lockfile installation, `npm run check`, and package dry-run on Ubuntu 24.04 and
macOS 26. The macOS lane protects canonical-path behavior such as the `/var` to `/private/var` temporary
directory alias. The repository mise and lock files remain the development-tool source of truth.

**Implementation:** `.github/workflows/ci.yml`.

## Recommendation 23 — Add live provider conformance jobs

**Status:** Corrected as a separate, environment-dependent gate.

A manual workflow executes actual Jujutsu, codesearch, Beads, and Pi/Bun checks. Public-tool jobs and
self-hosted integration jobs are separate from deterministic fixture CI and cannot be mistaken for fixture
results.

**Implementation:** `.github/workflows/live-conformance.yml`, `scripts/live-conformance.sh`.

## Recommendation 24 — Test multi-session and multi-repository behavior

**Status:** Corrected.

The suite covers isolated concurrent Pi sessions, real secondary repository snapshots, secondary drift,
workspace-root trust, and exact resume invalidation.

**Verification:** `tests/pi-extension.test.ts`, `tests/multi-repository-correctness.test.ts`.

## Recommendation 25 — Consolidate ADR numbering and current documentation

**Status:** Corrected.

Duplicate ADR identifiers were renumbered to 0020–0023; current trust, capabilities, completion, and
workspace-binding decisions are ADR-0024–0027, user-control/typed-validation behavior is ADR-0028, and
exact task scope/source isolation is ADR-0029. Superseded ADRs are marked. Release metadata checks reject
duplicate identifiers or mismatched headings.

## Recommendation 26 — Use one version source and create a release tag

**Status:** Corrected.

`ATELIER_VERSION` is the runtime source used by CLI and provider clients; package, lockfile, changelog,
README, and build metadata are checked against it. The bundle contains an annotated
`v0.14.0-alpha.10` tag.

**Implementation:** `packages/core/src/version.ts`, `scripts/check-release-metadata.ts`.

## Recommendation 27 — Package stable built output

**Status:** Corrected.

`tsconfig.build.json` emits JavaScript and declarations. Package entry points and `bin/atlr.mjs` consume
`dist`; source execution is explicitly development-only. `prepack` builds before packaging.

**Verification:** `npm run build`, launcher tests, and CI package dry-run.

## Recommendation 28 — Make provider-first retrieval advisory

**Status:** Corrected.

Provider tools are preferred and retrieval fallback is recorded, but broad raw inspection is no longer a
hard routing denial. Security authorization is independent from retrieval economy.

**Implementation:** config value `providerFirstRetrieval: "advisory" | "off"` and Pi routing behavior.

**Verification:** Pi tests cover advisory behavior after provider success, degradation, and budget limits.

## Recommendation 29 — Gate IDE-facing expansion on the guarded vertical workflow

**Status:** Corrected as project sequencing and release scope.

No claim is made that Ctrl-P, Ctrl-B, Yazi/skim, or dedicated Helix/diff UX is delivered. The current
release gate is the trusted plan-to-commit workflow, exact authorization, restart recovery, validation,
and evidence. Future IDE surfaces must consume these boundaries rather than bypass them.

**Documentation:** README, architecture, implementation plan, and this traceability document.


## Alpha.6 manual-acceptance corrections

The complete live alpha.5 evidence exposed additional user-control, static over-authorization, capability
disclosure, typed-tool reachability, cancellation lifecycle, execution-evidence, source-freshness, scoped
commit, Beads-idempotency, code-intelligence, and acceptance-procedure defects. Their evidence, 22
corrections, non-findings, and retained passes are documented in
`docs/MANUAL_ACCEPTANCE_CORRECTIONS.md`.
