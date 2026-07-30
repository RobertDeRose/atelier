# Build Report — Atelier 0.14.0-alpha.12

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

## Alpha.12 canonical-path correction

Alpha.12 preserves the completed workspace-recoverability model and corrects canonical path handling
exposed by the pinned macOS suite:

- typed Pi read, write, and edit targets are canonicalized before workspace and workflow evaluation;
- designated plan writes compare effective access paths rather than lexical `/var` and `/private/var` aliases;
- Git path classification and recovery canonicalize both the repository root and affected paths;
- broken symlinks and ignored or untracked recovery targets retain their repository-relative identity; and
- platform-independent tests assert canonical workspace and VCS state identities.

## Deterministic verification

```sh
npm run check:metadata
npm run typecheck
npm run build
npm test
bash scripts/smoke.sh
bash -n scripts/live-acceptance.sh
git diff --check
npm pack --dry-run
```

The final working tree passed:

```text
Release metadata:     passed
Type-check:           passed
Build:                passed
Deterministic tests:  247 passed, 0 failed
CLI smoke workflow:   passed
Acceptance syntax:    passed
git diff --check:     passed
Package dry-run:      passed
```

The package dry-run reports:

```text
Package:          atelier-prototype@0.14.0-alpha.12
Files:            415
Compressed size:  452,656 bytes
Unpacked size:    2,120,922 bytes
```

## Verification boundary

The available build environment did not contain a real `jj`, macOS `sandbox-exec`, or Linux `bwrap`
binary. Exact Git recovery is exercised against real Git repositories. Jujutsu operation recovery and
sandbox command construction are covered by deterministic fixtures and fail-closed tests; live Jujutsu,
Seatbelt, Bubblewrap, codesearch, Beads, and Pi/Bun checks remain the responsibility of the pinned mise
and live-conformance environments.

## Release classification

`0.14.0-alpha.12` remains an interactive alpha. Workspace containment and exact recoverability now form
the sole filesystem authority, but shell effect analysis remains intentionally conservative for arbitrary
interpreters, scripts, build systems, and dynamically computed effects. Those cases require one concrete
approval unless their effects can be bounded and recovered.
