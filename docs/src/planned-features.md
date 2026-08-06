# Planned Features

This page is the human-readable roadmap. Beads is authoritative for live status,
dependencies, claims, and ready-work selection.

## Project Overview

Atelier is a local-first, policy-aware workflow control plane for Pi. It owns
reviewed-plan execution, task reconciliation, authorization, durable evidence,
validation closure, Working State, and provider-neutral code intelligence. It
integrates with Jujutsu/Git and Beads without replacing editors, VCS, task
storage, provider indexing, configured validation commands, or OS sandboxing.

## Goals

- Preserve reviewable, recoverable local workflow execution.
- Keep Core authoritative for workflow and evidence decisions.
- Integrate providers and interactive hosts through narrow, replaceable
  contracts.

## Non-Goals

- Unattended privileged execution or persistent filesystem trust.
- A replacement for Pi, Beads, VCS, code-provider indexes, or OS sandboxing.
- Deferred fuzzy-palette, project-tree, and IDE surfaces.

## Global Constraints

- Beads is the live source for planning state; this page is a reader-facing
  roadmap.
- Each planned feature has a slug-scoped design and one Beads epic/molecule.
- Implemented records preserve delivery and audit history but do not become live
  task authority.
- Bounded, cancellable, redacted, fail-closed operations are mandatory.

## Cross-Cutting Decisions

- Core retains approval, reconciliation, repository evidence, validation,
  recovery, and closure authority.
- Launchers and hosts package, verify, initialize, and coordinate tools only.
- Private runtime state stays outside repositories and normal user profiles.
- Provider and host integrations receive explicit typed inputs; they do not
  derive authority from ambient configuration.

## Feature Map

### Thin Bun Launcher

- Status: planned
- Beads root: `atelier-7fw`
- Design: [Thin Bun Launcher](features/thin-bun-launcher/design.md)
- Overview: Package a verified private runtime and cross-platform Bun launch
  surface around Atelier while preserving Core as the sole workflow authority.
- Requirements:
  - Ship platform-specific compiled Bun launcher artifacts and add desktop
    launch surfaces through replaceable host adapters, beginning with macOS.
  - Verify pinned assets and initialize private runtime, profile, and mise
    state outside repositories and normal user profiles.
  - Package complete Pi payloads with only explicit private extensions.
  - Coordinate Herdr, Ghostty, and tuicr through bounded, typed adapters.
- Constraints:
  - The launcher cannot approve plans, grant execution, reconcile tasks, own
    repository evidence, or close work.
  - No system-runtime fallback, ambient extension discovery, dynamic
    AppleScript, or shell interpolation.
- Dependencies: The 23 child tasks under `atelier-7fw` are the authoritative
  execution graph; `atelier-7fw.1` is the first ready task.
- Suggested validation: behavior-driven contract, path, process, manifest,
  profile, asset, adapter, and platform acceptance tests, beginning with macOS.
- Documentation impact: architecture, user guide, development, reference,
  navigation, and the implemented record are updated by the assigned delivery
  tasks.

### First-class dstack workflow harness (`first-class-dstack-harness`)

- Status: in progress
- Beads root: `atelier-fon`
- Design: [First-class dstack workflow harness](features/first-class-dstack-harness/design.md)
- Overview: Make Atelier the execution harness for dstack's documentation-first,
  Beads-backed feature and task lifecycle while reducing context overhead through
  bounded code intelligence and preserving safety through snapshot-bound recovery.
- Requirements:
  - Make plan, start, implement, review, audit, pause, recover, and close first-class
    Core lifecycle operations shared by CLI and Pi.
  - Build reusable context capsules from relevant Beads state, designs, implemented
    records, code intelligence, review evidence, snapshots, and quality-gate inventory.
  - Preserve task identity, grants, scope, ownership, files, and explicit user control
    across restart, compaction, failure, and recovery.
  - Discover and enforce repository quality gates without requiring users to name
    internal validation definitions; preserve Git hooks, signing, filters, and user
    configuration by default.
- Constraints:
  - dstack documentation and Beads remain their respective authorities; Core owns
    execution, scope, snapshots, evidence, quality-gate enforcement, and closure.
  - Context reduction must be bounded and explicit about omissions; provider output,
    reports, and conversation history are observations, not authority.
  - No automatic mutation resume, implicit bypass, destructive migration, or second
    task-tracking system.
- Dependencies: The reviewed lifecycle gates under `atelier-fon` precede the bounded
  implementation workstreams; `atelier-k36` is the quality-gate workstream.
- Suggested validation: lifecycle, capsule-budget, snapshot/recovery, quality-gate,
  CLI/Pi integration, compatibility, documentation, and repository-standard checks.
- Documentation impact: architecture, development workflow, reference contracts, User
  Guide operations/CLI/Pi pages, navigation, roadmap, and the implemented record are
  reconciled by the assigned lifecycle and implementation tasks.
