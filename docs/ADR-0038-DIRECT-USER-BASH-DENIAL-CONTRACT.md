# ADR-0038: Direct User Bash Denial Uses Pi's Replacement-Result Contract

## Status

Accepted — 2026-08-02

## Context

Pi exposes two different pre-execution extension contracts:

- `tool_call` handlers may return `{ block, reason }` to prevent a model tool from running;
- `user_bash` handlers may return custom shell operations or a complete replacement `BashResult`.

Atelier previously returned the `tool_call` denial shape from its `user_bash` handler. Pi does not interpret
that shape as a direct-shell denial. With neither custom operations nor a replacement result, Pi continued
through its default shell executor after the user had selected **No**. An outside-workspace write could run,
and a likely-secret read could place its output in the Pi transcript despite durable Atelier denial evidence.

## Decision

Atelier treats the contracts as separate types and execution paths.

When a direct `!` or `!!` command is denied, Atelier returns a complete replacement `BashResult`:

- output begins with `DENIED BY ATELIER` and states that the command was not executed;
- exit status is `126`;
- `cancelled` and `truncated` are false;
- no executable `BashOperations` are returned.

The local Pi SDK declarations model `UserBashEvent`, `UserBashEventResult`, and `BashResult` explicitly so a
future attempt to return `{ block, reason }` from `user_bash` fails type checking.

Regression tests mirror Pi's fallback semantics: if a handler returns neither `result` nor `operations`, the
test executes the command through a default shell. The tests prove that rejected outside-workspace writes
create no marker and rejected likely-secret reads expose no command output.

## Consequences

- Direct user-shell rejection is authoritative at the Pi integration boundary, not merely in Atelier's ledger.
- The user sees an unmistakable nonzero shell result rather than a normal-looking successful command row.
- Model Bash continues to use `tool_call` blocking; direct user Bash uses replacement results.
- Pi API changes to `UserBashEventResult` must be reflected in Atelier's local SDK declarations and contract tests.
