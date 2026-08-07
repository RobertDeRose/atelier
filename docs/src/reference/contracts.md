# Contracts

This section collects exact commands, formats, configuration, and stable
contracts. Explanatory architecture belongs in [Architecture](../architecture/overview.md);
end-user procedures belong in the [User Guide](../user-guide/index.md); contributor
commands belong in [Development](../development/setup.md).

## Plan and workflow contracts

The canonical plan format is documented with the delivered
[Exact Plan Execution](../features/exact-plan-execution/index.md) feature.

## Context capsule contract

Core can build a bounded `ContextCapsule` for a task or feature through
`AtelierCore.buildContextCapsule()`. The caller supplies exact repository-relative
document paths and any already-inventoried quality gates; Core does not scrape
arbitrary files. Each section records its authority, exact location or boundary,
source digest, freshness, item count, byte count, omissions, and truncation state.

The capsule also contains a stable boundary digest, a stable content digest, a
redacted machine-readable value, and a compact Markdown rendering. Default limits
are 64,000 section bytes, 64,000 rendered-output bytes, 32 ordinary items, 20 history
entries, and 8 retrieval entries;
callers may provide lower positive limits. A capsule is reusable only when the task,
source snapshot identity, provider/retrieval state, documents, gates, and execution
boundary have the same digest. Changed source boundaries therefore fail closed to a
new capsule rather than reusing stale evidence. `ContextCapsuleCache` provides the
same-boundary reuse primitive without depending on Pi or terminal APIs.

## Repository quality-gate contract

Quality gates are repository policy, not task scope. Core discovers a bounded
`QualityGateProfile` without executing untrusted commands or asking users to name
individual checks. Discovery records the repository root, effective Git hook path,
configured signing and filter policy, tool identity, configuration locations and
digests, path coverage, and omissions. A repository with no discoverable gate has an
explicit `no-gate` profile; it is never silently treated as passing.

Discovery precedence is additive:

1. Observe native Git hooks, `core.hooksPath`, signing, and filter configuration;
   user configuration remains authoritative.
2. Discover declared repository adapters such as `hk.pkl`, `prek`, Husky, or
   devenv configuration, preserving each tool's native invocation and policy.
3. Discover `mise.toml` tasks and package-manager scripts as bounded fallback or
   aggregate entry points, retaining the underlying source location and command.
4. Report an explicit no-gate or incomplete-inventory result when no safe entry
   point is available. Discovery never invents a command from arbitrary output.

The current Atelier inventory includes `hk.pkl` (hk 1.49.0), the hk pre-commit
and check profiles, `mise.toml` tasks (`check`, `fix`, `docs:check`, `typecheck`,
and `test`), and package scripts (`check`, `typecheck`, `test`, path-alias, and
smoke). `bd hooks list --json` reports the tracked Beads hook shims installed for
pre-commit, pre-push, post-merge, post-checkout, and prepare-commit-msg. No project
prek, Husky, or devenv declaration was found. No repository `core.hooksPath` or
filter override was observed; the effective user Git configuration currently
requires SSH commit signing and must be preserved by gate and commit adapters.
The inventory is an observation and must be refreshed before a lifecycle decision.

A `QualityGateRunResult` binds every run to the exact source/staged snapshot,
gate/configuration/tool digests, command and changed-path coverage. It reports
`passed`, `failed`, `cancelled`, `timed_out`, `unavailable`, `mutation_detected`,
or `blocked` status, plus bounded redacted stdout/stderr, truncation flags,
cancellation/timeout details, and before/after mutation observations. Gate failures
retain their real cause and stale or incomplete evidence cannot satisfy closure.

Bypasses are not inferred. Core never supplies `--no-verify`, `--no-gpg-sign`, an
empty `core.hooksPath`, disabled filters, alternate signing configuration, or an
environment override. The supported quality-gate bypass is single-use,
actor-bound, source-bound to one commit operation, explicitly confirmed, and
recorded with its reason and `expiresAfter: next-commit-attempt`; it skips only
the selected quality gate and does not weaken Git policy. Existing named validation
manifests and evidence remain
readable as historical compatibility records while quality-gate discovery is
migrated.

## Implementation contracts

The current code and tests remain the authority for implementation details that
are not yet documented as a supported contract. Provider-specific contracts and
retrieval limits are documented with the
[Code Intelligence and Retrieval](../features/canonical-retrieval-planning/code-intelligence/index.md)
feature documentation.
