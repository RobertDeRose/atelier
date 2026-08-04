# ADR-0033: Persistent Markdown Reports for Atelier Commands

## Status

Accepted; amended for alpha.18 — 2026-07-30

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
slash-command output. Report entries do not participate in LLM context. They render through Pi's Markdown component resolved from the executable that launched Pi. Atelier
declares the Pi coding-agent and Pi TUI packages as optional peers, resolves the Markdown component
through the host installation, and adapts the initialized theme supplied to the entry-renderer callback
into Pi TUI's Markdown theme contract. A deterministic plain-text fallback remains
for tests and non-Pi hosts; failure to load the TUI runtime is displayed explicitly instead of silently
showing raw Markdown source.

The following commands create persistent reports:

- `/status`
- `/workflow` (`/state` compatibility alias)
- `/ready` when listing work
- `/code-status`
- `/code-index`
- `/code-search`
- `/code-symbols`
- `/changed`
- `/validate`
- `/evidence`

Every report is presented as a visually separated card with a horizontal rule and concise summary header.
Collapsed cards show `➤`; expanded cards show `▼` and render the full Markdown body. Sparse status and
workflow summaries use bold field/value lines. Dense ready-task and code-result collections use tables or
grouped sections. `/workflow` is the canonical durable workflow report; `/state` remains a compatibility
alias, and `full`/`--full` exposes the complete diagnostic Working State when required.

The footer uses a neutral `disabled` intelligence state when no provider is configured. `offline` is
reserved for a configured provider that is unavailable or failed. Thinking-level text uses normal
foreground contrast; only separators and tertiary metadata are dimmed.

A guided verification script clears the terminal before each direct Pi session, identifies the intended
workspace and VCS, keeps detailed instructions in separate guide files, launches Pi without a pseudo-TTY
recorder, and gathers authoritative CLI/VCS/ledger evidence afterward.

## Consequences

- Structured command output remains visible in transcript scrollback without starting an agent turn.
- Reports are excluded from model context and do not consume conversation authority.
- Manual testing can distinguish consecutive cards and compare `/workflow`, `/status`, and code results after subsequent commands.
- TUI hosts lacking the current entry-renderer API fall back to notifications; this compatibility path is
  intentionally less capable.
- The Pi coding-agent and Pi TUI Markdown/entry-renderer APIs are explicit optional peer dependencies.
- Runtime module resolution is anchored to the launched Pi executable, matching global npm and mise installations.
