# Design — Thin Bun Launcher

## Metadata

- Beads feature root: `atelier-7fw`
- Feature slug: `thin-bun-launcher`
- Design path: `docs/src/features/thin-bun-launcher/design.md`
- Implemented record: `docs/src/features/thin-bun-launcher/index.md`
- Status: planned

## Feature Summary

Package a verified, private cross-platform Bun runtime and launch surface around Atelier without moving Core workflow authority into the launcher, Herdr, Ghostty, Pi, or tuicr. Platform-specific hosts, beginning with macOS, remain replaceable adapters.

## User Intent

Launch Atelier from a CLI or supported desktop entry point with a private pinned runtime that does not trust ambient Pi, mise, shell, or repository configuration.

## Goals

- Build a thin compiled Bun launcher for supported operating systems and architectures.
- Add platform-specific launch surfaces through replaceable adapters, beginning with a macOS application.
- Verify pinned runtime assets, initialize private state, and coordinate Herdr, Pi, Ghostty, mise, and tuicr through narrow adapters.
- Preserve Core authority for approval, task reconciliation, repository evidence, validation, recovery, and closure.

## Non-Goals

Do not create a second workflow authority, rely on system runtime tools, dynamically generate AppleScript, or ship a universal binary first.

## User-Facing Behavior

The launcher will expose `verify`, `doctor`, `repair`, `launch`, and `terminal-client`, and use a one-use structured launch request for terminal hosting.

## Requirements

### Functional Requirements

Ship separate platform and architecture artifacts, complete official Pi payloads with explicit private extensions, private mise state, idempotent Herdr topology, and host-specific terminal integration such as static AppleScript on macOS.

### Quality Requirements

Every subprocess is argument-array based, bounded, cancellable, redacted, and fail closed. Runtime files, requests, paths, and environments are verified before use.

### Compatibility and Migration Requirements

Private launcher state is isolated from repositories and normal Pi/mise profiles. Existing Core data and authority remain unchanged.

## Existing Context

Core already supplies boundary, process, redaction, repository identity, recovery, and workflow primitives. The 23 child tasks beneath `atelier-7fw` define the executable plan.

## Proposed Design

Keep `apps/launcher` a thin package of pure contracts and adapters. The compiled launcher resolves and verifies bundle resources, creates private runtime state, and coordinates vendor tools; Core remains the only workflow authority.

## Architecture Consistency

### Existing Patterns Reused

Use Core path-boundary, process-environment, redaction, async-process, repository identity, and recovery contracts through narrow runtime-neutral adapters.

### Invariants Preserved

No launcher component may approve plans, grant execution, reconcile tasks, own repository evidence, or close work. Pi extension loading is explicit and mutable state is private.

### New Decisions Introduced

The launcher packages, verifies, initializes, and coordinates only; it has no product authority.

### Architecture Documentation Changes

Update architecture, the user guide, development, reference, and the implemented record as delivery tasks land. Do not restore a legacy decision-document catalog.

## Operational Considerations

Document supported platforms and architectures, private state, doctor/repair, asset mismatch, cancellation, recovery, installation, and removal during the release tasks. The first desktop-host documentation covers macOS.

## Documentation Impact

| Documentation concern      | Exact page                                     | Create or update        | Planned change                                 | Owning Beads task |
|----------------------------|------------------------------------------------|-------------------------|------------------------------------------------|-------------------|
| Architecture               | `docs/src/architecture/overview.md`            | Update                  | Launcher/Core authority boundary               | `atelier-7fw.1`   |
| User Guide                 | `docs/src/user-guide/index.md`                 | Update                  | Install, launch, diagnose, recover, and remove | `atelier-7fw.23`  |
| Development                | `docs/src/development/setup.md`                | Update                  | Build and validate artifacts                   | `atelier-7fw.20`  |
| Reference                  | `docs/src/reference/contracts.md`              | Update                  | Commands, errors, and artifact contracts       | `atelier-7fw.2`   |
| Navigation                 | `docs/src/SUMMARY.md`                          | Update                  | Register implemented record at close-out       | `atelier-7fw.23`  |
| Implemented Feature Record | `docs/src/features/thin-bun-launcher/index.md` | Create during close-out | Preserve delivery and audit history            | `atelier-7fw.23`  |

## Validation Strategy

Use behavior-driven contract, path, environment, process, manifest, profile, asset, adapter, and platform acceptance tests. The first release gate covers macOS clean-account checks and signed artifacts; each later platform adds its own bounded, redacted acceptance evidence.

## Implementation Decomposition

Beads `atelier-7fw` contains 23 dependency-ordered tasks: authority and contracts; runtime/process/path/assets/profile; private mise, Pi, and Herdr integration; terminal and macOS adapters; deterministic builds; live acceptance; tuicr; and release documentation.

## Dependencies and Parallelism

The Beads graph is authoritative. The first ready task is `atelier-7fw.1`; later runtime work depends on its contract and authority foundation.

## Rollout and Migration

Start with a compiled cross-platform CLI and private runtime, add an ad-hoc-signed macOS dogfood bundle after the runtime gate, then add other platform hosts and production signing after deterministic artifacts and platform acceptance.

## Risks and Tradeoffs

Vendor compatibility, downloaded assets, ambient configuration, launch requests, AppleScript, credentials, and output are untrusted inputs. Pin and verify releases; fail closed rather than silently use host tools.

## Rejected Alternatives

Reject launcher-owned workflow authorization, ambient extension discovery, system-runtime fallback, unpinned acquisition, dynamic AppleScript, and universal binaries as the first release artifact.

## Open Questions

Vendor capability and compatibility claims must be verified against pinned releases by their assigned Beads tasks.

## Deferred Decisions

Automatic updates, universal binaries, and host replacement remain separate features.

## Planning Record

### Questions Asked and Answers

The supplied launcher plan established the authority boundary, private profiles, explicit extensions, static AppleScript, and architecture-specific release order.

### Assumptions

Vendor adapters remain narrow and replaceable after their pinned contracts are verified.

### Design Changes During Planning

The imported launcher plan was decomposed into 23 Beads tasks and recorded as feature `atelier-7fw`.

### Source Material

Beads epic `atelier-7fw` and its 23 child tasks.
