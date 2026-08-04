# User Guide

Atelier keeps the person using the agent in control of the workflow. Use this
guide to prepare a workspace, review proposed work, run it safely, and recover
when a provider or process fails.

## Prepare a workspace

The first `atlr launch` from a project initializes the small `.atelier/`
configuration files automatically. You do not need to run a separate init step.

To inspect setup without changing project files, run:

```sh
atlr doctor
```

`doctor` is observational. It reports the workspace, available tools, and
configured providers in a human-readable summary, ending with an `Operational`
or `Degraded` status and any detected issues. Use `atlr doctor --json` when a
script needs machine-readable output. Initialization does not grant
permanent filesystem trust.

## Review and execute work

Atelier's normal sequence is:

1. Inspect the current workflow state.
2. Review or edit the plan in the configured editor.
3. Inspect the exact plan hash, task projection, repository bindings, and
   validation requirements.
4. Approve the displayed transaction.
5. Start the selected task explicitly.
6. Use Pi or the CLI to make changes within the approved scope.

A changed plan, repository revision, provider identity, or task binding
invalidates the affected approval. Atelier stops rather than silently widening
the transaction.

## Observe progress and results

Use the status and workflow surfaces to see the current task, repository state,
retrieval freshness, validation state, and next action. Tool evidence records
what was attempted and what changed afterward; permission to attempt a mutation
is not treated as proof that a mutation occurred.

## Validate and close

Run the required focused checks, review the final diff, and confirm that the
repository and validation evidence are current before closing a task. A failed,
interrupted, or stale validation cannot satisfy the closure predicate.

## Recover safely

Atelier keeps runtime state outside the repository and creates exact recovery
checkpoints when an operation could discard dirty or untracked work. If a
process, provider, or session stops, restart Atelier and inspect the
reconstructed Working State before continuing. Cancellation revokes the active
execution grant without reverting source changes or silently changing task
state.

## Find implementation context

For code-intelligence usage, provider behavior, and bounded retrieval evidence,
see [Code Intelligence and Retrieval](../features/canonical-retrieval-planning/code-intelligence/index.md).
