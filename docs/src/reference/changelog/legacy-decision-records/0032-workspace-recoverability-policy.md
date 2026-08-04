# Legacy Decision Record 0032 — Session workspace recoverability policy

Status: Accepted

## Context

Atelier previously combined project trust, persisted permission grants, task capability bundles, and a
separate shell approval model. That produced overlapping authorities and repetitive prompts without
providing exact recovery for dirty VCS state.

## Decision

Atelier has one filesystem authority: the immutable session workspace and recoverability policy.

The workspace is the canonical startup working directory unless `--workspace <path>` is supplied. It is
captured before later directory changes and never expands to a repository root or narrows after `chdir`.
Pi `/trust` remains independent and controls only Pi project-local resources.

The runtime is split into four responsibilities:

1. **Effect Analyzer** — derives concrete read, create, mutate, delete, overwrite, execute, network,
   privilege-escalation, and unknown effects from structured tools or shell syntax.
2. **Workspace Guard** — canonicalizes existing targets or the nearest existing ancestor for new targets
   and rejects traversal or symlink escape.
3. **Recovery Manager** — classifies VCS state, creates exact verified checkpoints when necessary, and
   exposes a durable restore identifier.
4. **Policy Evaluator** — returns `allow`, `checkpoint_then_allow`, `ask`, or `deny` from containment,
   secret sensitivity, privilege, and exact recoverability.

Reviewed plan execution metadata remains a workflow constraint. It limits the files, validations,
dependency changes, and local change that belong to the approved task, but it is not a second filesystem
permission system.

## Default policy

- Ordinary non-secret reads inside the workspace are allowed.
- New paths inside the workspace are allowed.
- Clean tracked mutation or deletion inside the workspace is allowed because the prior state is directly
  recoverable from VCS.
- Destructive changes to dirty tracked paths create a verified checkpoint before execution.
- Existing untracked or ignored content is checkpointed before destructive replacement when practical;
  otherwise Atelier asks once for the concrete consequence.
- Likely-secret access, privilege escalation, outside-workspace effects, and unknown or indeterminate
  persistent effects ask once.
- Denial is reserved for explicit workflow or platform invariants.

## Exact recovery

### Git

A checkpoint captures:

- the current `HEAD` identity;
- the exact scoped index entries;
- staged and unstaged state, including partially staged files;
- intent-to-add and skip-worktree/assume-unchanged flags where present;
- rename, mode, deletion, conflict, symlink, and worktree state;
- required untracked or ignored filesystem contents.

Restoration refuses to proceed if `HEAD` changed, restores the copied filesystem state and exact index,
then verifies the scoped status and index match the checkpoint.

### Jujutsu

A checkpoint captures the active working-copy identity and operation ID. Restoration uses native
`jj op restore`, updates the workspace when needed, and verifies the restored operation and working-copy
identity. Copied ignored or untracked content remains part of the checkpoint.

Checkpoints are created atomically below Atelier's external runtime directory, bounded by size and path
suitability, verified before execution, and associated with the initiating tool call and Pi session.
Failed checkpoints are removed and cause Atelier to ask before continuing.

## Shell execution

Pi's model-facing `bash` tool and direct `user_bash` commands share the same pre-execution policy path.
The actual Bash executor requires a matching authorization token from the intercepted operation; calling
it directly fails closed.

Straightforward shell chains, pipelines, redirections, and deterministic file operations are analyzed.
Quoted separators are not treated as pipelines, `/dev/null` is not treated as an outside-workspace
persistent target, and unknown destructive effects remain conservative.

When available, macOS Seatbelt or Linux Bubblewrap adds runtime containment with the workspace writable,
external filesystem read-only or unavailable, credential locations hidden, network disabled by default,
and a minimal environment. Runtime confinement is defense in depth: it does not convert an indeterminate
destructive effect into an automatic allow. If no sandbox backend exists, only an operation already
allowed or concretely approved by the workspace evaluator may use the unsandboxed fallback.

## Migration

- `/atelier-trust`, `atlr trust`, and Atelier trust persistence are removed.
- The legacy policy engine, permission profiles, permission grants, remembered approvals, and active
  permission table are removed.
- Old trust files are ignored.
- The ledger migration deletes the legacy permission table rather than reinterpreting its records.
- Existing reviewed plan execution metadata is retained only as task scope and completion constraints.

## Consequences

Normal repository reading, editing, testing, formatting, refactoring, creation, and recoverable tracked
deletion proceed with few prompts. Users are interrupted only for a concrete protected or unrecoverable
consequence. The remaining limitation is that shell effect analysis is intentionally conservative for
interpreters, arbitrary scripts, build systems, and dynamically computed effects; those operations ask
unless their effects are otherwise concrete and recoverable.
