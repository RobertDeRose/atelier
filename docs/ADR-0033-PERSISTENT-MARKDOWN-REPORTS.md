# ADR-0033: Persistent Markdown Reports for Atelier Commands

## Status

Accepted — 2026-07-30

## Context

Atelier previously rendered `/status`, `/state`, code-intelligence results, changed paths, validation
results, and evidence through Pi notifications. Notifications are transient, use subdued styling, are
replaced by later notifications, and do not provide durable transcript scrollback for structured output.
This made operational state difficult to compare and made manual acceptance evidence unreliable.

Code-intelligence-disabled workspaces were also presented as `offline`, which conflated an intentional
configuration choice with provider failure. The footer dimmed the thinking level even when the active
Pi theme made dim text difficult to read.

## Decision

Atelier registers a TUI-only custom session-entry renderer and appends report entries for structured
slash-command output. Report entries do not participate in LLM context. They render through Pi's Markdown
component when available and retain a deterministic plain-text fallback for tests and non-TUI hosts.

The following commands create persistent reports:

- `/status`
- `/state`
- `/ready` when listing work
- `/code-status`
- `/code-index`
- `/code-search`
- `/code-symbols`
- `/changed`
- `/validate`
- `/evidence`

Status-like reports use compact Markdown tables. Working State uses headings and lists. Code results group
definitions, source, tests, documentation, generated files, and references separately.

The footer uses a neutral `disabled` intelligence state when no provider is configured. `offline` is
reserved for a configured provider that is unavailable or failed. Thinking-level text uses normal
foreground contrast; only separators and tertiary metadata are dimmed.

A guided verification script clears the terminal before each direct Pi session, identifies the intended
workspace and VCS, keeps detailed instructions in separate guide files, launches Pi without a pseudo-TTY
recorder, and gathers authoritative CLI/VCS/ledger evidence afterward.

## Consequences

- Structured command output remains visible in transcript scrollback without starting an agent turn.
- Reports are excluded from model context and do not consume conversation authority.
- Manual testing can compare `/state`, `/status`, and code results after subsequent commands.
- TUI hosts lacking the current entry-renderer API fall back to notifications; this compatibility path is
  intentionally less capable.
- The Pi Markdown and entry-renderer APIs become an explicit optional runtime dependency of the extension.
