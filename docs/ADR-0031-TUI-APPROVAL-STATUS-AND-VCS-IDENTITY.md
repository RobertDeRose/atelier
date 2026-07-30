# ADR-0031: TUI approval, status, and VCS identity

## Status

Accepted — 2026-07-29

## Context

Manual TUI acceptance showed that accepting an exact execution transaction injected a synthetic user message and immediately started implementation. The generic confirmation surface did not make the full capability bundle reliably visible, status output treated an absent plan as approved when both hashes were undefined, execution-grant identity was omitted, no-task closure was presented as blocked, and Pi's Git-only footer displayed `detached` in colocated Jujutsu workspaces.

## Decision

- Exact approval performs reconciliation and installs the reviewed task constraints, then returns Pi to idle. It uses a passive notification rather than `sendUserMessage`.
- The complete reconciliation and task-constraint summary is rendered as a persistent widget and notification before the final confirmation.
- Core status owns an explicit `planStatus` and exposes the active execution grant.
- Pi and CLI status surfaces render the same plan, task, execution-grant, and VCS identity.
- Working State renders closure as not applicable when no active task exists.
- TUI sessions install an Atelier footer that renders `jj <change>` for Jujutsu and `git <commit>` for Git, together with model, Atelier status, and context usage. Non-TUI modes retain the normal status mechanism.

## Consequences

Approval no longer implies autonomous execution. Users can inspect the exact authority they are granting and explicitly decide when implementation starts. Jujutsu users no longer see a misleading detached Git identity. Atelier replaces Pi's built-in footer in TUI sessions and must preserve the useful model and context information it needs to display.
