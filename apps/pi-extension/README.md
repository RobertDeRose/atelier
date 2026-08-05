# Atelier Pi Extension

This extension provides the interactive Atelier shell behavior for Pi.

## Efficient code retrieval

Each Pi session owns one bounded Atelier retrieval session. The same compact evidence
inventory survives agent turns and conversational compaction, then closes during
`session_shutdown`.

The retrieval sequence is:

1. Read exact known paths directly. For an unknown location or cross-file concept, run one focused
   semantic `atlr_code_search` discovery.
2. Inspect the inventory and reuse decision included in that response.
3. Use model-facing `atlr_code_symbols` only for identifiers listed as unresolved. Explicit human
   `/code-symbols` and CLI requests may perform a direct lookup.
4. Use Pi's built-in `read` tool for known or returned paths.
5. Prefer provider evidence before broad raw scanning, but use exact typed reads or an explicitly approved
   shell operation when provider evidence is insufficient, wrong, excluded, or budget-limited.

Retrieval routing is advisory; security authorization remains independent from retrieval economy.
Every code-tool response reports the session inventory, freshness, remaining budgets, deduplication, returned bytes, truncation, invalidations, repository scopes, and the latest provider-call or reuse decision. Original provider provenance remains attached to fresh and reused evidence.

Repository, provider identity, and index revision changes invalidate affected evidence before another decision. Historical observations may remain for explanation, but they are marked non-current and cannot satisfy Working State retrieval after reopen.

The extension consumes the provider-neutral budgets from `.atelier/config.json`: `codeMaxProviderRequests`, `codeMaxResults`, `codeMaxUniquePaths`, `codeMaxEvidenceEntries`, `codeMaxFetches`, and byte limits. `codeRetainedSessions`, `codeMaxPersistedEntries`, and `codeMaxPersistedBytes` bound restart state.

Troubleshooting:

- Inspect `/code-status` before another search; it includes the current inventory.
- Read a known path directly when the decision says `direct_read`.
- A model-tool `no_provider_call` symbol decision means semantic discovery has not left that identifier
  unresolved. Use explicit `/code-symbols` only when a human intentionally requests the lookup.
- Start a new Pi session after a genuine request-budget exhaustion, or use exact typed inspection when the
  remaining question cannot be answered from current evidence.
- Reindex when status is stale or failed. Critical evidence still needs direct inspection.

## Commands

The slash commands mirror the `atlr` CLI verbs:

- `atlr status` → `/status`
- `atlr plan` → `/plan <objective>`
- `atlr review` → `/review`
- `atlr approve` → `/approve`
- `atlr approve --task ID [--write PATH[,PATH]] [--validation NAME[,NAME]] --yes` → `/approve --task ID [--write PATH[,PATH]] [--validation NAME[,NAME]]`
- `atlr task start ID --standalone [--write PATH[,PATH]] [--validation NAME[,NAME]] --yes` → `/task-start ID [--write PATH[,PATH]] [--validation NAME[,NAME]]`
- `atlr execute [task-id]` → `/execute [task-id]`
- stop current turn → `/atelier-stop`
- pause agent mutation → `/atelier-pause [reason]`
- resume paused execution → `/atelier-resume`
- `atlr cancel --reason <text>` → `/cancel [reason]`
- `atlr ready` → `/ready [task-id]`
- `atlr state` → `/workflow` (`/state` compatibility alias)
- `atlr code status` → `/code-status`
- `atlr code index` → `/code-index`
- `atlr code search` → `/code-search <query>`
- `atlr code symbols` → `/code-symbols <identifier>`
- `atlr changed` → `/changed`
- `atlr validate plan` → `/validate plan`
- `atlr validate focused` → `/validate focused`
- model state → `atlr_state`
- model validation → `atlr_validate` (`plan`, `focused`, or named `run`)
- model local change → `atlr_commit`
- model task closure → `atlr_task_close`
- `atlr evidence` → `/evidence`

Pi command names use hyphens because Pi registers one command token after `/`.

The CLI approval sequence is intentionally exact and non-interactive-safe:

```sh
atlr review
atlr plan prepare --json
atlr approve --approval <id> --digest <reconciliation-digest> --yes
```

`review` prints the durable `ManualEdit` structural diff, plan diagnostics, and reconciliation preview. `prepare` reports the full plan hash, provider identity, operation details, retirements, and proposed first task. A non-interactive planned `approve` refuses to apply without the matching ID, digest, and `--yes`; an interactive terminal may confirm the same displayed transaction. Existing standalone tasks can instead use `atlr approve --task <id> [--write <path[,path]>] [--validation <name[,name]>] --yes` or `/task-start <id> [--write <path[,path]>]`. Without `--write`, standalone activation covers all application-source paths while excluding Atelier/provider metadata and dependency manifests; `--write` narrows the scope. Standalone activation never creates or reconciles `.atelier/PLAN.md`, and the effective scope remains enforced by Core. Use `atlr task start [id] --yes` or `atlr execute [id] --yes` only after explicit closure exposes later approved-plan work. `atlr cancel --reason <text>` revokes execution authorization without closing the provider task. Pi
`/cancel` does not wait for idle and can abort an active turn after the durable grant is revoked.
`/atelier-stop` leaves execution active, while `/atelier-pause` and `/atelier-resume` persist the agent
mutation state without starting another model turn.

## Hooks

- `session_start`: opens Atelier state, validates or fails closed any durable execution, starts one retrieval session, and updates status.
- `session_shutdown`: interrupts unfinished tool evidence, closes the retrieval session, and closes SQLite state.
- `tool_call`: classifies and gates actions before execution, including provider-first raw-discovery routing, then starts durable evidence for authorized mutations.
- `tool_result`: completes success, failure, or interruption evidence for every mutating result and
  refreshes workflow/validation status. Interruption comes from structured abort state or an exact
  tool-owned abort sentinel, never arbitrary process output. One-operation grants are consumed by
  authorization regardless of the result.
- `before_agent_start`: revalidates execution and injects deterministic Atelier Working State, next action, and compact retrieval inventory.
- `session_before_compact`: revalidates execution and supplies task-backed reconstruction rather than a conversationally authoritative summary.
- Approved act-mode work auto-allows only the exact reviewed source paths, named `atlr_validate`
  operations, task closure, and an optional path-scoped local commit. Task update/link capabilities are
  not implied. Authorization does not override the user's latest instruction not to validate, use Bash,
  commit, close, or continue. Destructive, external, unknown, publication, and
  out-of-repository effects still prompt.
- `agent_settled`: leaves incomplete active tasks idle and emits at most one passive readiness warning;
  it never schedules a follow-up model turn. The authoritative predicate is enforced when closure is
  requested.
- `agent_settled`: automatically opens every completed initial plan draft in the configured editor,
  records the `ManualEdit`, and displays its structural summary and reconciliation readiness.

## Editor handoff

The extension uses Pi's custom UI lifecycle to stop the TUI, run the editor as a direct foreground child with inherited standard streams, restart the TUI, and request a render. It does not invoke a shell and does not emit alternate-screen control sequences. Non-TUI sessions receive an actionable recovery message directing them to run `atlr review` in a terminal.

The SQLite ledger and Working State remain authoritative across restart and compaction. Pi conversation text and custom session entries are never used to infer approval, task activation, permissions, mutation outcomes, or validation freshness. `/status` and `/workflow` expose the durable next action: review, resolve reconciliation conflicts, approve, execute, validate, close, or select later ready work.

## Acceptance and restart

The portable fake-Pi acceptance test is `tests/acceptance-workflow.test.ts`; it does not substitute for a live TUI result. Maintainers should run the final workflow through `mise run launch` only from a disposable Jujutsu-first clone, reject one exact transaction before approving it, verify focused-validation staleness/rerun, restart Pi, and then exercise `/cancel` and optional `/execute`. The full checklist and evidence fields are in [`docs/src/development/local-acceptance.md`](../../docs/src/development/local-acceptance.md).

An upgrade must preserve `.atelier/PLAN.md`, the SQLite ledger, `TaskProvider`/Beads state, provider indexes, Jujutsu operation/workspace state, and legitimate working-copy changes. Exit the old Pi process, update without cleaning those assets, restart with `mise run launch`, and inspect `/status` plus `/workflow`. Invalid plan/provider/repository/task bindings fail closed instead of silently resuming act mode.
