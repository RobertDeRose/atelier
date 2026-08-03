# Example Atelier Implementation Plan

<!-- atlr:plan version="1" -->

## ATLR-001 — Establish guarded runtime
<!-- atlr:task
{
  "id": "ATLR-001",
  "priority": 1,
  "type": "task",
  "execution": {
    "writePaths": [
      "packages/core/src/policy",
      "tests/action-classifier.test.ts",
      "tests/workspace-policy.test.ts"
    ],
    "allowDependencyChanges": false,
    "validations": [],
    "allowFullSuite": false,
    "allowLocalChange": true
  }
}
-->

### Goal

Create the policy and provenance boundary required before repository mutation.

### Scope

- Action classification
- Workspace effect analysis and exact recovery checkpoints
- Durable policy decisions

### Out of scope

- Semantic repository indexing
- Capability forging

### Depends on

- None

### Validation

- Run the policy and classifier unit tests

### Completion criteria

- Read-only actions are allowed by default
- Contained recoverable mutations proceed without repetitive approval
- Unrecoverable, secret, privileged, or outside-workspace effects ask once

### Notes

- Runtime enforcement is authoritative; prompts are advisory

## ATLR-002 — Add task-backed continuation
<!-- atlr:task
{
  "id": "ATLR-002",
  "priority": 2,
  "type": "feature",
  "execution": {
    "writePaths": [
      "packages/core/src/tasks",
      "packages/core/src/state",
      "tests/reconciliation-state.test.ts"
    ],
    "allowDependencyChanges": false,
    "validations": [],
    "allowFullSuite": false,
    "allowLocalChange": true
  }
}
-->

### Goal

Reconstruct working state from durable task state instead of model-authored compaction.

### Scope

- Beads task-provider adapter
- Ready-task selection
- Approved-plan mapping
- Bounded working state

### Out of scope

- Embedding retrieval
- Multi-agent scheduling

### Depends on

- ATLR-001

### Validation

- Run reconciliation and working state integration tests

### Completion criteria

- Reconciliation is idempotent
- The first unblocked task is selected deterministically
- Provider outages do not prevent read-only investigation

### Notes

- Current repository source remains authoritative for code behavior
