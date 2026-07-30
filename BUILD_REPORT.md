# Build Report — Atelier 0.14.0-alpha.13

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

## Alpha.13 footer correction

Alpha.13 preserves the completed workspace-recoverability model and replaces the dense single-line Pi
footer with a two-line responsive status surface:

- line one aligns Atelier/model/thinking/context on the left and workflow mode/task/blocker on the right;
- line two aligns provider-native Git or Jujutsu identity and clean/dirty/conflicted state on the left
  with code-intelligence health on the right;
- headings use Pi theme bold/accent rendering while good, warning, and failure states use semantic colors;
- wide terminals show human-readable Beads task titles, medium terminals truncate the title, and narrow
  terminals fall back to the Beads ID; and
- expected empty workflow states and duplicate VCS identity are omitted.

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
Deterministic tests:  249 passed, 0 failed
CLI smoke workflow:   passed
Acceptance syntax:    passed
git diff --check:     passed
Package dry-run:      passed
```

The package dry-run reports:

```text
Package:          atelier-prototype@0.14.0-alpha.13
Files:            415
Compressed size:  458,001 bytes
Unpacked size:    2,148,447 bytes
```

## Verification boundary

The available build environment did not contain a real `jj`, macOS `sandbox-exec`, or Linux `bwrap`
binary. Exact Git recovery is exercised against real Git repositories. Jujutsu operation recovery and
sandbox command construction are covered by deterministic fixtures and fail-closed tests; live Jujutsu,
Seatbelt, Bubblewrap, codesearch, Beads, and Pi/Bun checks remain the responsibility of the pinned mise
and live-conformance environments.

## Release classification

`0.14.0-alpha.13` remains an interactive alpha. Workspace containment and exact recoverability now form
the sole filesystem authority, but shell effect analysis remains intentionally conservative for arbitrary
interpreters, scripts, build systems, and dynamically computed effects. Those cases require one concrete
approval unless their effects can be bounded and recovered.
