
# Atelier overview

- Project kind: `application`

## Purpose

Provide a local-first, policy-aware workflow control plane for Pi with reviewed-plan execution, task reconciliation, authorization, durable evidence, validation closure, Working State, and code-provider orchestration.

## Intended users

Developers and coding agents using Pi who need local, reviewable, and recoverable workflow execution.

## Current scope

The atlr CLI and Pi extension for local session-workspace policy, reviewed-plan execution, task reconciliation, exact authorization and recovery, durable evidence, validation closure, Working State, and provider-neutral codesearch/Octocode orchestration, integrated with Jujutsu/Git and Beads.

Future behavior belongs in [Planned features](../planned-features.md) until delivered.

## Boundaries

Atelier does not replace editors, VCS, Beads task storage, provider indexing/retrieval, configured validation commands, or OS sandboxing. It does not provide unattended privileged execution, persistent filesystem trust, or the deferred fuzzy-palette/project-tree/IDE surfaces.
