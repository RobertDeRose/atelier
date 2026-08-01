# ADR-0037: Canonical Path Identity and Filesystem Entry Semantics

- **Status:** Accepted
- **Date:** 2026-08-01

## Context

Atelier receives paths from startup directories, plans, Pi tools, shell analysis, Git/Jujutsu output, code providers, validation manifests, and multi-repository configuration. On macOS, one directory may be spelled as both `/var/...` and `/private/var/...`. Repository roots may also be reached through symlinks, and a requested file may not exist yet.

Computing `relative(root, path)` before resolving both sides can turn an in-repository path into an escaping `../../...` pathspec. Conversely, resolving a final symlink too early loses the identity of the repository entry itself: Git tracks `tracked-link`, not the target file.

## Decision

Atelier uses one shared path identity model:

1. **Lexical path** — the caller-facing absolute spelling, resolved against an explicit base.
2. **Entry path** — all parent aliases are canonicalized while the final filesystem entry is preserved.
3. **Canonical target** — every existing ancestor and the final symlink are resolved.

Repository roots and workspace identities use canonical targets. Git/Jujutsu pathspecs, reviewed write scopes, fingerprints, and recovery snapshots use entry paths. Workspace containment and secret/outside-workspace evaluation use canonical targets, while secret-shaped entry names are also retained for classification.

Relative repository inputs are always resolved against the selected repository root, never `process.cwd()`. Missing paths are rebuilt below the nearest existing canonical ancestor. Repository providers return path-state results under the caller key and canonical entry key.

## Consequences

- macOS `/var` and `/private/var` identify one repository and workspace.
- Symlinked repository roots and missing descendants produce stable in-worktree pathspecs.
- A final tracked symlink remains distinct from its target for workflow and recovery purposes.
- Descendants of an escaping symlink remain outside the workspace.
- Repository-aware code must use the shared helpers rather than direct `resolve()`, `relative()`, or prefix comparisons.
- Tests cover alias roots, relative inputs, missing paths, valid and broken symlinks, VCS state, code providers, workflow authorization, and recovery.
