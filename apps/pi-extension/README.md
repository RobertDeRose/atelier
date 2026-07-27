# Atelier Pi Extension

This extension provides the interactive Atelier shell behavior for Pi.

## Efficient code retrieval

Each Pi session owns one bounded Atelier retrieval session. The same compact evidence
inventory survives agent turns and conversational compaction, then closes during
`session_shutdown`.

The enforced sequence is:

1. Run one focused semantic `atlr_code_search` discovery.
2. Inspect the inventory and reuse decision included in that response.
3. Use `atlr_code_symbols` only for identifiers listed as unresolved.
4. Use Pi's built-in `read` tool for known or returned paths.
5. Use broad raw scanning only when Atelier reports unavailable, unhealthy, stale,
   degraded, failed, or genuinely empty provider evidence.

Cache reuse, request-budget denial, and agent preference do not enable raw scanning.
Every code-tool response reports the session inventory, freshness, remaining budgets, deduplication, returned bytes, truncation, invalidations, repository scopes, and the latest provider-call or reuse decision. Original provider provenance remains attached to fresh and reused evidence.

Repository, provider identity, and index revision changes invalidate affected evidence before another decision. Historical observations may remain for explanation, but they are marked non-current and cannot satisfy Working State retrieval after reopen.

The extension consumes the provider-neutral budgets from `.atelier/config.json`: `codeMaxProviderRequests`, `codeMaxResults`, `codeMaxUniquePaths`, `codeMaxEvidenceEntries`, `codeMaxFetches`, and byte limits. `codeRetainedSessions`, `codeMaxPersistedEntries`, and `codeMaxPersistedBytes` bound restart state.

Troubleshooting:

- Inspect `/code-status` before another search; it includes the current inventory.
- Read a known path directly when the decision says `direct_read`.
- A `no_provider_call` symbol decision means semantic discovery has not left that identifier unresolved.
- Start a new Pi session after a genuine request-budget exhaustion; raw scanning is not enabled by denial.
- Reindex when status is stale or failed. Degraded or unavailable status enables guarded raw fallback, but critical evidence still needs a direct read.

## Commands

The slash commands mirror the `atlr` CLI verbs:

- `atlr status` → `/status`
- `atlr plan` → `/plan <objective>`
- `atlr review` → `/review`
- `atlr approve` → `/approve`
- `atlr ready` → `/ready [task-id]`
- `atlr state` → `/state`
- `atlr code status` → `/code-status`
- `atlr code index` → `/code-index`
- `atlr code search` → `/code-search <query>`
- `atlr code symbols` → `/code-symbols <identifier>`
- `atlr changed` → `/changed`
- `atlr validate plan` → `/validate plan`
- `atlr validate focused` → `/validate focused`
- `atlr evidence` → `/evidence`

Pi command names use hyphens because Pi registers one command token after `/`.

## Hooks

- `session_start`: opens Atelier state, starts one retrieval session, and updates status.
- `session_shutdown`: closes the retrieval session and SQLite state.
- `tool_call`: classifies and gates actions before execution, including provider-first
  raw-discovery routing.
- `before_agent_start`: injects deterministic Atelier Working State and its compact
  retrieval inventory.
- `session_before_compact`: supplies task-backed reconstruction rather than a free-form
  authoritative summary.
- Approved act-mode work auto-allows routine repository-scoped edits, validation,
  task updates, and local commits. Destructive, external, unknown, publication,
  and out-of-repository effects still prompt.
- `agent_settled`: prevents selected-task work with uncommitted changes from being
  reported complete without validation, final diff inspection, and a local commit.
- `agent_settled`: opens a changed plan draft in the configured editor.

## Editor handoff

The extension uses Pi's custom UI lifecycle to stop the TUI, run the editor as a direct
foreground child with inherited standard streams, restart the TUI, and request a
render. It does not invoke a shell and does not emit alternate-screen control
sequences.
