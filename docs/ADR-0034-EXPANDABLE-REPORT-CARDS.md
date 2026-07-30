# ADR-0034: Expandable Report Cards and Workflow Command Naming

## Status

Accepted — 2026-07-30

## Context

Persistent Markdown fixed transient command output, but consecutive reports still merged visually in
scrollback. `/status` used an under-filled table, while `/state` exposed the complete diagnostic Working
State and was difficult to distinguish conceptually from `/status`.

## Decision

Atelier renders every persistent report as a card with a horizontal divider and concise summary header.
The header uses `➤` while Pi reports the entry as collapsed and `▼` while expanded. Pi owns the global
entry expansion control; Atelier does not invent a separate per-entry click protocol.

Sparse reports use bold field/value lines. Dense task collections may use tables, and code results remain
grouped by definition, reference, source, test, documentation, and generated content.

`/status` is the concise current snapshot. `/workflow` is the canonical durable workflow report and omits
empty diagnostic sections by default. `/state` remains a compatibility alias. `/workflow full` or
`/state full` renders the complete diagnostic Working State.

## Consequences

- Consecutive command results are visibly separated in scrollback.
- Collapsed reports remain useful because their headers include report-specific summaries.
- The distinction between current status and durable workflow context is explicit.
- Individual mouse-click expansion remains dependent on a future Pi per-entry interaction API; current
  expansion follows Pi's persistent-entry expanded state.
