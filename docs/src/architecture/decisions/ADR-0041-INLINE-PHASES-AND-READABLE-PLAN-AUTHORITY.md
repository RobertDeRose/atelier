# ADR-0041: Present Transient Work Inline and Format Plan Authority for Review

## Status

Accepted. The inline-footer phase surface is superseded by ADR-0042; the immediate workflow-state, plan-format, and exact-file direct-read decisions remain current.

## Date

2026-08-03.

## Context

Guided acceptance showed that phase feedback solved silent multi-second pauses, but
an above-editor widget looked like transcript output: plain text appeared and was
then cleared. The same run also showed two reviewability problems:

- task authority was compressed into one long `atlr:task` JSON comment; and
- an objective that named both implementation files still triggered irrelevant
  semantic retrieval before planning.

A pause transition was durable immediately but could take roughly a second to appear
in the footer because rendering waited for a complete repository/provider status
observation.

## Decision

- Publish transient phase text through Pi's extension status channel and Pi's native
  working message. While Pi is idle, Atelier's custom footer renders the status as
  one static inline status field; no transient phase widget is added to the
  transcript area.
- Yield one event-loop turn after publishing a phase, then start expensive work.
  Continue recording `ui.phase_changed` evidence for presentation ordering.
- Render pause, resume, and cancellation optimistically from durable ledger state
  before starting the normal asynchronous status refresh. A later full observation
  remains authoritative for repository and provider state.
- Canonically format every valid `atlr:task` comment as a multiline, indented JSON
  block before ManualEdit opens. Continue parsing legacy one-line comments for
  compatibility.
- If a planning objective names every file it asks Atelier to modify, use direct-read
  decisions and suppress semantic discovery unless the objective also asks for an
  unknown implementation location or broader impact analysis.
- Keep tests and guided evidence for the inline phase surface, immediate pause state,
  readable metadata, and direct-read planning decision.

## Consequences

- Long-running commands remain visibly active without adding transient rows to
  transcript scrollback.
- Workflow-control commands acknowledge state changes immediately while preserving
  asynchronous freshness checks.
- Human reviewers can inspect task authority without manually reformatting JSON.
- Existing plans remain readable because the parser accepts both old and new formats;
  the next review canonicalizes valid legacy metadata.
- Small, explicitly scoped plans avoid unnecessary provider latency and irrelevant
  retrieval evidence.
