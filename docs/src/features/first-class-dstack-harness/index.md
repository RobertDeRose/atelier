# First-class dstack workflow harness

## Delivery Summary

- Beads feature root: `atelier-fon`
- Status: ready for delivery
- Pull request: not created
- Merge commit: not created
- Design record: [design.md](design.md)

## Delivered Capability

Atelier now provides a Core-owned dstack workflow harness over the existing CLI, Pi, Beads, Git/Jujutsu,
retrieval, and runtime-state boundaries. It coordinates planning, review, activation, bounded task execution,
quality gates, evidence, recovery, and explicit closure without creating a second task authority.

- Core models feature/task lifecycle state and exposes a typed next action for CLI and Pi.
- Context capsules combine bounded task, review, snapshot, retrieval, quality-gate, and document evidence with
  provenance, redaction, freshness, deterministic digests, omissions, and explicit item/byte/history/retrieval
  budgets. Unchanged capsules reuse only within a fresh task/provider and source boundary.
- Repository snapshots, execution baselines, recovery checkpoints, grants, reviews, quality-gate evidence, and
  closure decisions remain bound to task, scope, ownership, repository, and source identities.
- Quality-gate discovery and execution preserve hooks, signing, filters, repository configuration, bounded output,
  cancellation, mutation detection, and one-turn user-authorized bypass expiry.
- CLI and Pi expose equivalent lifecycle, status, evidence, recovery, quality-gate, and closure actions while Core
  remains authoritative.
- Existing plans, execution contracts, grants, task records, validation records, and historical evidence remain
  readable through additive migration; legacy validation evidence is distinguishable from current quality-gate
  evidence.

## User-Facing Behavior

Use `atlr` or Pi for the shared workflow. Review the prepared plan and discovered repository checks before explicit
activation, implement only the selected task's approved scope, inspect bounded status/evidence, and review the exact
diff before committing or closing. Restart, pause, cancellation, and recovery preserve task identity and scope but
never resume mutation without an explicit user action.

Use the [CLI reference](../../user-guide/cli.md), [Pi reference](../../user-guide/pi.md), and [operations guide](../../user-guide/operations.md)
for commands, blockers, quality-gate failures, compatibility records, snapshots, and recovery procedures.

## Design Integration

The implementation follows the reviewed authority layers: dstack documentation defines feature intent, Beads owns
live task state, Core owns execution/evidence/scope/recovery/closure decisions, VCS owns repository state, repository
policy owns quality gates, providers supply bounded observations, and CLI/Pi render Core state. Conversation history,
compaction summaries, provider output, and reports remain non-authoritative evidence.

The existing `atelier-k36` quality-gate workstream remains implementation-owned beneath the dstack coordinator. Its
legacy validation migration is additive and does not require new work to name internal validation definitions.

## Operational Impact

Refresh status before sensitive operations when switching between CLI and Pi. Inspect the current snapshot, task
scope, quality-gate profile, evidence, and next action rather than relying on transcript history. Provider/index
outages, stale evidence, dirty scope, hook/signing/filter failures, and recovery-required states produce bounded
remediation and remain fail-closed.

The repository-standard release metadata guard is still blocked by the pre-existing `atelier-zdm` issue because
`apps/pi-extension/src/index.ts` exceeds its configured line-count limit. This limitation is recorded with the
validation evidence and is separate from the delivered dstack behavior.

## Reference and Contracts

- [Architecture overview](../../architecture/overview.md)
- [Workflow commands](../../development/workflow-commands.md)
- [Core contracts](../../reference/contracts.md)
- [User Guide](../../user-guide/index.md)
- [Shared state, context, quality gates, and recovery](../../user-guide/operations.md)

## Validation Evidence

All checks below were run against the implementation worktree at commit
`130d21b0bd31a0d2ebc34aaee8a5fe145a1648bf`, unless noted otherwise:

- `npm test` — passed, 396/396 tests.
- `npm run typecheck` — passed.
- `npm run build` — passed.
- `uv run scripts/check-docs.py` — passed.
- `mise exec -- hk check -a` — passed.
- `git diff --check` — passed.
- `bash -n scripts/guided-verification.sh` — passed.
- Focused context-capsule, Beads-provider, quality-gate, and end-to-end lifecycle tests — passed.
- `mise run check` — blocked by the pre-existing release metadata line-count guard tracked as `atelier-zdm`
  (`apps/pi-extension/src/index.ts`: 1350 lines; configured limit: 1300). No bypass was used.

## Design Reconciliation

### Delivered as Designed

The Core authority boundary, Beads task identity, bounded context, snapshot/recovery safety, repository quality-gate
policy, migration compatibility, and thin CLI/Pi adapters all match the reviewed design and acceptance criteria.

### Intentional Changes

New work uses discovered repository quality gates rather than requiring users to name abstract validation definitions.
Legacy validation manifests and evidence remain readable as historical compatibility data. Context-capsule reuse now
requires a fresh bounded task/ready observation so external task changes do not silently reuse stale context.

### Deferred Work

Pull-request creation, merge, post-merge delivery reconciliation, and feature worktree removal remain pending the
user's explicit delivery choice. Fresh interactive Pi restart/recovery verification and the Pi extension line-count
cleanup remain separate follow-up work; no external provider is made a prerequisite for local deterministic tests.

### Rejected or Removed Scope

No reviewed scope was removed. Automatic mutation resume, implicit quality-gate bypasses, authority in UI/transcripts,
unbounded context/history scans, and repository-policy bypasses remain rejected.

## Documentation Updated

- `docs/src/features/first-class-dstack-harness/design.md`
- `docs/src/features/first-class-dstack-harness/index.md`
- `docs/src/features/index.md`
- `docs/src/SUMMARY.md`
- `docs/src/planned-features.md`
- `docs/src/architecture/overview.md`
- `docs/src/development/workflow-commands.md`
- `docs/src/reference/contracts.md`
- `docs/src/user-guide/index.md`
- `docs/src/user-guide/cli.md`
- `docs/src/user-guide/pi.md`
- `docs/src/user-guide/operations.md`
- `docs/src/user-guide/setup.md`

## Audit Trail

- Beads: `atelier-fon`; implementation coordinator `atelier-fon.14`; documentation reconciliation `atelier-fon.15`;
  validation `atelier-fon.16`; delivery reviews `atelier-fon.17` and `atelier-fon.18`; delivery `atelier-fon.19`.
- Quality-gate workstream: `atelier-k36` with children `.1` through `.8`.
- Implementation commits include `8f83bfb1cdd94cad3ee052a1184ee7f42b4dce4c`,
  `31662bcaeb5f784effe0289ea3f45c91c7b0a979`, `21b2886936b67ba291a08803d6d874afe3af6bea`,
  `94207d9a373b1dfd99e24418d22d45ce1d948a8f`, `6f4a685264fb59e232d2e0911df5a5572d260acb`,
  `12c6cf2c3acb8fd9c13537238359212871e1cc16`, `ccb43ef2e69829371a177fe9b13cdb3063158dd2`, and
  `130d21b0bd31a0d2ebc34aaee8a5fe145a1648bf`.
- Specification and implementation review evidence is retained in the corresponding Beads notes and ephemeral
  review packets. Close-out reviews and delivery state are recorded in the remaining lifecycle beads.
