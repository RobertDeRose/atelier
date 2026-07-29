# Build Report — Atelier 0.14.0-alpha.9

## Result

Atelier builds successfully as stable JavaScript and declarations. The supported launcher consumes
`dist` rather than TypeScript source.

Delivered entry points:

```text
dist/packages/core/src/index.js
dist/packages/core/src/index.d.ts
dist/apps/cli/src/main.js
dist/apps/pi-extension/src/index.js
```

The package exports Core JavaScript/types, declares the built Pi extension, and retains `bin/atlr.mjs`
as the CLI entry. `prepack` rebuilds the package; source execution is development-only.


## Alpha.9 TUI control correction

Alpha.9 makes exact approval an approval-only transaction, renders the complete capability scope before confirmation, exposes execution-grant and plan-state details consistently, treats closure as not applicable when no task exists, and installs a VCS-aware Pi footer that displays Jujutsu change identity or Git commit identity instead of a misleading detached Git label.

## Alpha.7 macOS verification correction

The alpha.6 implementation already canonicalized exact capability paths under the trusted repository
root. The new narrow-capability regression compared those paths with the noncanonical macOS
`/var/folders/...` fixture alias, while production correctly returned `/private/var/folders/...`. Alpha.7
updated the assertion to use Atelier's canonical configured repository root and adds no production
authorization change.

## Alpha.6 correction boundary

The complete alpha.5 manual evidence was reviewed rather than treating the abort loop as an isolated
symptom. This release corrects:

- forced `agent_settled` follow-up turns after denial or abort;
- `/cancel` waiting for an idle state that Atelier itself prevented;
- failed commands being mislabeled interrupted because output mentioned `signal` or `AbortSignal`;
- absence of a typed model-facing validation operation;
- misleading missing-validation-selection diagnostics;
- explicit human symbol lookup being blocked by autonomous inventory policy;
- raw symbol display labels, contradictory resolved/unresolved state, cache non-convergence, and
  cross-repository scope ambiguity;
- malformed exact-symbol hints extracted from expressions;
- permissive `.beads` directory mode;
- over-segmented tiny plans and excessively verbose code-provider presentation;
- the reboot-unsafe and trust-store-truncating commands in the prior live acceptance procedure;
- the alpha.5 static whole-repository capability bundle and non-disclosed authorization scope;
- missing typed state, local-change, and task-close operations plus unenforced per-turn tool restrictions;
- non-atomic cancellation and duplicate execution-resume events;
- per-tool evidence attributing all already-dirty paths;
- workflow metadata invalidating source evidence and being swept into task commits;
- destructive repeated Beads initialization; and
- mandatory semantic discovery despite exact known paths.

The original 29 review corrections remain in force. Traceability is split between
`docs/REVIEW_CORRECTIONS.md` and `docs/MANUAL_ACCEPTANCE_CORRECTIONS.md`; ADR-0028 records the user-control
and typed-validation decision, while ADR-0029 records exact task scope and source isolation.

## Deterministic verification

```sh
npm run check:metadata
npm run typecheck
npm run build
npm test
bash scripts/smoke.sh
npm pack --dry-run
```

In the construction environment, release metadata, type-checking, compilation, package dry-run, shell syntax, and the focused workflow/security regression groups passed. The focused groups covered 31 core workflow tests plus the Pi, security, validation, and repository-provider regressions run separately. The complete all-files test command was started but exceeded the container command limit without reporting a failure; the pinned Node 24.18.0 `mise run check` remains the authoritative complete gate before merging.

The package dry-run reports:

```text
Package: atelier-prototype@0.14.0-alpha.9
Files: 335
Compressed size: 395,486 bytes
Unpacked size: 1,877,567 bytes
```

CI executes the deterministic gate on the pinned Node 24.18.0 toolchain on Ubuntu 24.04 and macOS 26. Real Jujutsu, codesearch, Beads, and Pi/Bun checks remain separate manually dispatched conformance jobs because external tool availability is environment-dependent.

## Release classification

`0.14.0-alpha.9` remains a trusted-repository, interactive alpha. It does not provide an operating-system
sandbox for arbitrary shell commands and is not approved for unattended or untrusted-repository use.
Prompt clarification improves agent behavior but is not a security boundary; typed policy, explicit user
denial, and durable authorization remain authoritative.

## Alpha.8 repository-finalization correction

Alpha.8 adds regression coverage for nonexistent typed reads, escaping symlinks, source-clean pre-close readiness, separate workflow-metadata finalization, raw repository cleanliness, completed Working State, and blocker-derived next actions. The live-acceptance harness is now retained in-tree and asserts top-level Pi tool executions, unexpected tool errors, no forced continuation after denial, actual model-facing symbol resolution, and a clean raw Jujutsu workspace after closure.
