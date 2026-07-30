# Migration Report — Atelier 0.14.0-alpha.18

## Alpha.18 report-card compatibility

No state migration is required. Persistent reports now render as expandable cards with divider lines and
concise summaries. `/workflow` is the canonical durable workflow report; `/state` remains a compatibility
alias, and `full` or `--full` retains the previous complete diagnostic Working State. Existing persisted
report entries without summaries continue to render with their title only. Pi's global persistent-entry
expansion state controls `➤` and `▼`; no new keybinding or per-entry state is stored by Atelier.

## Alpha.17 callback-theme compatibility

No state migration is required. Persistent report rendering now derives its Markdown theme from the initialized theme object Pi passes to the entry-renderer callback. Atelier still resolves Pi's `Markdown` component from the active Pi installation, but no longer imports or calls the coding-agent global `getMarkdownTheme()` singleton. This removes initialization-order coupling in deterministic tests and nonstandard hosts while preserving the active Pi theme in interactive sessions.

## Alpha.15 Pi Markdown rendering compatibility

No state migration is required. Persistent Atelier report entries now resolve Pi's own
`@earendil-works/pi-tui` and `getMarkdownTheme()` through the executable that launched the current Pi
process. This matches Pi's extension dependency model and avoids project-local or global npm layout
assumptions.

The raw-text compatibility renderer remains only for non-Pi hosts and deterministic test doubles. When a
TUI host cannot load Pi's Markdown runtime, Atelier now displays an explicit renderer diagnostic rather
than silently showing unstyled Markdown source.

## Alpha.14 persistent report compatibility

No state migration is required. Structured Pi inspection commands now append TUI-only Markdown session
entries rather than transient notifications. These entries remain in transcript scrollback, are excluded
from LLM context, and survive ordinary session persistence. Hosts without Pi's custom-entry renderer fall
back to notifications.

A configured `codeProvider: "disabled"` now appears as the neutral `intel: disabled` state. `offline` is
reserved for configured providers that are unavailable or failed. Footer thinking levels use normal text
contrast. Existing footer configuration values remain unchanged.

The in-tree `scripts/guided-verification.sh` replaces pseudo-terminal recording with direct Pi sessions,
clears each workspace transition, stores full instructions in guide files, and archives authoritative
CLI, VCS, ledger, recovery, and task-provider evidence.

## Alpha.13 footer compatibility

No state or configuration migration is required. The default `footer: "atelier"` mode now owns two
terminal rows and derives task titles, Git branches, Jujutsu bookmarks/change IDs, repository cleanliness,
thinking level, context pressure, and code-index health from current runtime state. Existing
`footer: "status-only"` and `footer: "disabled"` settings keep their previous behavior.

## Alpha.12 canonical path compatibility

No state migration is required. Alpha.12 canonicalizes typed tool and Git recovery paths before
comparison. This removes macOS `/var` versus `/private/var` alias mismatches without changing workspace
selection, checkpoint format, task state, or policy decisions.

## Filesystem authority migration

Atelier now has one filesystem authority: the immutable session workspace and recoverability policy.
The workspace defaults to the canonical startup working directory. `--workspace PATH` explicitly selects
a different canonical root for the current process. Changing directory later does not change the boundary.

Pi `/trust` remains independent and controls only Pi project-local resources. Atelier does not provide
`/atelier-trust`, `atlr trust`, a trusted-project database, remembered approval, or workspace trust UI.
Old Atelier trust files are ignored and are never reinterpreted as workspace roots.

## Legacy permission removal

The legacy policy engine, permission profiles, permission grants, active permission table, and filesystem
capability bundle have been deleted. The ledger migration drops old permission storage rather than
converting it. Existing reviewed plan `execution` metadata remains valid, but it now constrains task scope
and completion only; it does not grant filesystem permission.

## Recovery checkpoints

Destructive dirty tracked operations create an exact verified checkpoint before execution when practical.
Git checkpoints preserve the scoped index and worktree state, including partial staging, modes, renames,
symlinks, ignored files, and untracked files. Jujutsu checkpoints use the native operation log and verify
the restored operation and working-copy identity. Each checkpoint records its tool call, Pi session, and
`atlr recovery restore CHECKPOINT_ID` command.

Checkpoint creation is atomic and bounded. Failed or unsuitable checkpoints are removed and the concrete
operation asks before continuing.

## Shell execution

Pi model Bash and direct user shell commands share the same effect analyzer, workspace guard, recovery
manager, and one-time consequence prompt. The Bash executor requires a matching pre-execution
authorization token. Seatbelt or Bubblewrap adds runtime confinement where available; without a backend,
only operations already allowed or explicitly approved by the policy may use the fallback executor.

## Plan and provider compatibility

Existing plans with valid `execution` metadata continue to parse. Use `atlr plan scope` or `/plan-scope`
to update task constraints canonically. Beads continues to use `BD_JSON_ENVELOPE=1` while accepting both
legacy and v2 envelope responses. No task-provider data migration is required.

## Runtime and evidence

Runtime state remains external to the repository. Minimal subprocess environments, evidence redaction,
data lifecycle commands, async providers, unified status presentation, navigation, diff review, and the
optional local Core service from alpha.10 remain compatible.
