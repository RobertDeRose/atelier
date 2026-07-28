# Build Report — Atelier 0.14.0-alpha.4

## Result

The critical-review correction release builds successfully as stable JavaScript and declarations. The
supported launcher consumes `dist` rather than TypeScript source.

Delivered build outputs:

```text
dist/packages/core/src/index.js
dist/packages/core/src/index.d.ts
dist/apps/cli/src/main.js
dist/apps/pi-extension/src/index.js
```

The package exports Core JavaScript/types, declares the built Pi extension, and retains `bin/atlr.mjs`
as the CLI entry. `prepack` runs the build; source execution is explicitly development-only.

## Corrected release boundary

The release corrects the stop-ship authorization and trust defects identified at commit `286e2bc14edb`:

- external project and workspace-root trust;
- no repository-controlled provider/editor/validator/index startup before trust;
- unconfined generic shell with one-operation approval;
- real-path confinement for typed operations;
- exact source, workspace, retrieval, reconciliation, and capability bindings;
- authoritative validation/diff/commit/clean task closure;
- explicit provider-observation failures;
- staged and untracked Git evidence;
- session-owned Pi state and awaited asynchronous shutdown;
- external runtime state and observational diagnostics;
- collision-free Pi command registration: Pi retains `/trust`, while Atelier uses `/atelier-trust`;
- canonical Pi trust identity and notification evidence across repository aliases, including macOS `/var` paths.

The complete traceability matrix is `docs/REVIEW_CORRECTIONS.md`.

## Deterministic verification

```sh
npm run check:metadata
npm run typecheck
npm test
npm run build
bash scripts/smoke.sh
npm pack --dry-run
```

The local deterministic suite passes 191 tests. CI executes the same deterministic gate on Node 24.18.0
on Ubuntu 24.04 and macOS 26. The plan-review and Pi trust regressions assert that emitted paths use
Atelier's canonical configured or trusted identity, including macOS `/var` aliases. Real Jujutsu,
codesearch, Beads, and Pi/Bun
checks are defined as separate manually dispatched conformance jobs because external tool availability
is environment-dependent.

## Release classification

`0.14.0-alpha.4` is a trusted-repository, interactive alpha. It does not provide an operating-system
sandbox for arbitrary shell commands and is not approved for unattended or untrusted-repository use.
