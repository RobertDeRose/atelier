# Build Report — Atelier 0.14.0-alpha.18

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

## Alpha.18 expandable report-card correction

Alpha.18 makes consecutive persistent reports visually distinct and reduces sparse or diagnostic-heavy output:

- every report renders a horizontal divider plus a concise summary header;
- collapsed entries use `➤`, expanded entries use `▼`, following Pi's persistent-entry expansion state;
- `/status` uses concise bold field/value lines instead of a sparse table;
- `/workflow` is the canonical durable workflow report and `/state` remains a compatibility alias;
- `/workflow full` retains the complete diagnostic Working State when deep inspection is required;
- default workflow output omits empty sections and summarizes task, execution, validation, retrieval, and blockers; and
- dense ready-task and code-result collections retain tables or grouped sections where they improve scanning.

## Deterministic verification

```sh
npm run check:metadata
npm run typecheck
npm run build
npm test
bash scripts/smoke.sh
bash -n scripts/live-acceptance.sh
bash -n scripts/guided-verification.sh
git diff --check
npm pack --dry-run
```

The final working tree passed:

```text
Release metadata:     passed
Type-check:           passed
Build:                passed
Deterministic tests:  258 passed, 0 failed
CLI smoke workflow:   passed
Acceptance syntax:    passed
git diff --check:     passed
Package dry-run:      passed
```

The package dry-run reports:

```text
Package:          atelier-prototype@0.14.0-alpha.18
Files:            425
Compressed size:  473,005 bytes
Unpacked size:    2,212,956 bytes
```

## Verification boundary

The available build environment did not contain a real `jj`, macOS `sandbox-exec`, or Linux `bwrap`
binary. Exact Git recovery is exercised against real Git repositories. Jujutsu operation recovery and
sandbox command construction are covered by deterministic fixtures and fail-closed tests; live Jujutsu,
Seatbelt, Bubblewrap, codesearch, Beads, and Pi/Bun checks remain the responsibility of the pinned mise
and live-conformance environments.

## Release classification

`0.14.0-alpha.18` remains an interactive alpha. Workspace containment and exact recoverability now form
the sole filesystem authority, but shell effect analysis remains intentionally conservative for arbitrary
interpreters, scripts, build systems, and dynamically computed effects. Those cases require one concrete
approval unless their effects can be bounded and recovered.
