# User Guide

Atelier is the local-first control plane around Pi. It keeps plan review, task
activation, workspace policy, recovery, quality-gate evidence, and task closure
durable while letting Git or Jujutsu, Beads, editors, and code providers keep
their native responsibilities.

Use this guide when you are operating an existing project. For installation
and the shortest first-run path, start with the [Quickstart](../getting-started/quick-start.md).

> **Development safety note:** New workspaces currently initialize with
> `securityMode: "core-only"`. This disables workspace permission prompts and OS
> shell sandboxing so code intelligence, Beads, and Jujutsu/Git can be exercised
> without safety-layer friction. It is unsafe for untrusted or unattended work.
> Set `securityMode: "enforced"` in `.atelier/config.json` to restore those gates.

## Choose an interface

The `atlr` CLI and the Pi extension expose the same workflow through different
surfaces. Both read the project files and durable runtime state; neither makes
conversation history or a provider's output authoritative.

| Use the CLI when you need to                                     | Use Pi when you need to                                   |
|------------------------------------------------------------------|-----------------------------------------------------------|
| script or automate an inspection                                 | iterate with an agent in the terminal                     |
| use a non-interactive terminal or CI-like environment            | review a plan in the configured editor from the TUI       |
| inspect JSON, provider health, evidence, or recovery checkpoints | see status reports and phase feedback in the transcript   |
| launch the local Core service or diagnose installation           | pause, stop, or cancel the current agent turn immediately |

A process creates its own Core instance, but all clients use the same project
configuration, repository, task provider, and external Atelier runtime ledger
for the repository. When switching clients, inspect state first with `atlr
status`, `/status`, or `/workflow`. Do not run competing approval or commit
transactions concurrently.

## The normal path

The durable workflow is:

1. **Prepare.** Run `atlr launch` or start Pi from the repository. Use `doctor`
   when you want diagnostics without initialization.
2. **Plan.** In Pi, use `/plan OBJECTIVE`; in a terminal, use
   `atlr plan OBJECTIVE`. A plan must be reviewed before it can be approved.
3. **Review.** Use `/review` or `atlr review` to open the plan and record the
   exact `ManualEdit` and structural diff.
4. **Approve.** Pi `/approve` or the CLI's `plan prepare` followed by
   `approve --approval ID --digest DIGEST --yes` displays and applies one exact
   transaction. Successful approval activates the first task and leaves Pi
   idle; it does not start implementation automatically.
5. **Implement.** Send an explicit implementation request in Pi, or use the
   CLI to inspect and control the session. Use `/execute` or `atlr execute`
   only to activate a later approved-plan task after the previous task ends.
6. **Validate and inspect.** Run the selected checks, inspect `/evidence` or
   `atlr evidence`, then review the exact final diff.
7. **Finalize.** Record one local change with `/commit MESSAGE` or
   `atlr repo commit --message MESSAGE`, then close with `/close` or
   `atlr task close ID --reason TEXT`.

For a ready task that does not need a plan, use standalone activation:
`/task-start TASK_ID` or `atlr approve --task TASK_ID --yes`. Standalone
activation still has an exact write scope and the same evidence, quality-gate,
commit, and closure gates; it never edits or reconciles `.atelier/PLAN.md`.

## Safety boundaries

- The startup directory, or one explicit `--workspace` path, is the immutable
  session workspace. Atelier does not create a permanent trust grant.
- Plan approval is bound to the reviewed plan hash, provider and repository
  revisions, reconciliation digest, retrieval identity, and reviewed task
  constraints. Drift causes a fresh review or preparation instead of widening
  authority.
- A reviewed task constraint is workflow scope, not a general filesystem
  permission. Workspace containment, likely-secret checks, privilege checks,
  and VCS/checkpoint recoverability are evaluated independently.
- `/atelier-stop` ends one current turn. `/atelier-pause` keeps the task active
  but disables agent mutation. `/cancel` revokes execution without closing the
  task or reverting source files.
- Closure is explicit and requires current quality-gate evidence (or an approved
  no-gate policy), exact final-diff review, local change, and repository cleanliness. An
  incomplete task can remain paused or idle.

## Guide map

- [Setup, launch, and configuration](setup.md) covers workspace initialization,
  editors, providers, runtime state, and multi-repository workspaces.
- [CLI reference](cli.md) covers command groups, exact approval, quality gates,
  compatibility evidence, recovery, and closure.
- [Pi reference](pi.md) covers every Atelier slash-command and its workflow
  transition.
- [Shared state, quality gates, and recovery](operations.md) explains client
  boundaries, gate evidence, closure blockers, and troubleshooting.

## Command vocabulary

Atelier commands use the `atlr` executable. Pi commands use the same short verb
where possible, for example `atlr status` and `/status`. Pi-only controls keep
the `atelier-` prefix where that distinguishes a turn or navigation operation,
for example `/atelier-pause` and `/atelier-open`.

Pi's `/trust` command is not an Atelier command. It controls loading Pi-owned
project resources only; it does not grant Atelier filesystem authority.
