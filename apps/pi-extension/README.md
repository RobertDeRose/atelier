# Atelier Pi Extension

This extension provides the interactive Atelier shell behavior for Pi.

## Commands

The slash commands mirror the `atlr` CLI verbs:

- `atlr status` → `/status`
- `atlr plan` → `/plan <objective>`
- `atlr review` → `/review`
- `atlr approve` → `/approve`
- `atlr ready` → `/ready [task-id]`
- `atlr state` → `/state`
- `atlr index` → `/index`
- `atlr search` → `/search <query>`
- `atlr validate` → `/validate [name]`
- `atlr evidence` → `/evidence`

Pi command names use hyphens because Pi registers one command token after `/`.

## Hooks

- `session_start`: opens Atelier state and updates status.
- `session_shutdown`: closes SQLite state.
- `tool_call`: classifies and gates actions before execution.
- `before_agent_start`: injects deterministic Atelier Working State.
- `session_before_compact`: supplies task-backed reconstruction rather than a free-form authoritative summary.
- Approved act-mode work auto-allows routine repository-scoped edits, validation,
  task updates, and local commits. Destructive, external, unknown, publication,
  and out-of-repository effects still prompt.
- `agent_settled`: prevents selected-task work with uncommitted changes from being
  reported complete without validation, final diff inspection, and a local commit.
- `agent_settled`: opens a changed plan draft in the configured editor.

## Editor handoff

The extension uses Pi's custom UI lifecycle to stop the TUI, run the editor as a direct foreground child with inherited standard streams, restart the TUI, and request a render. It does not invoke a shell and does not emit alternate-screen control sequences.
- `atlr symbols` → `/symbols <query>`
- `atlr changed` → `/changed`
- `atlr validate plan` → `/validate plan`
- `atlr validate focused` → `/validate focused`
