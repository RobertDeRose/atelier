# ADR-0016: Explicitly activate Atelier code tools in Pi

- **Status:** Accepted
- **Date:** 2026-07-25

## Context

Atelier registered `atlr_code_search`, `atlr_code_symbols`, and `atlr_code_status` as Pi extension
tools and instructed the model to use them before broad repository scans. A live planning session
still used Bash `find` and `rg` discovery. Pi separates tool registration from the active-tool list
used for a model turn, so registration alone did not guarantee that the model could select the
provider tools.

## Decision

When code intelligence is enabled, Atelier will explicitly add its three read-only code tools to
Pi's active-tool set and place them before the existing tools. Atelier will converge that selection
on session start, plan entry, and before every agent turn.

Provider-first Bash interception remains a separate enforcement layer. It blocks broad raw discovery
until provider evidence is unavailable, unhealthy, degraded, failed, or empty. It does not convert a
read-only command into an approval request.

## Consequences

- The model can actually call the tools named in Atelier's plan instructions.
- Resumed sessions and active-tool changes converge before the next turn.
- Exact file reads and read-only shell commands remain available.
- Users with `codeProvider: "disabled"` retain their existing active-tool selection.
- Tool activation and provider-first interception are independently testable.
