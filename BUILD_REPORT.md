# Build Report — Atelier 0.14.0-alpha.16

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

## Alpha.16 mise Pi Markdown resolution correction

Alpha.16 keeps persistent TUI-only report entries and corrects Pi host discovery for mise and global npm layouts:

- Pi's `Markdown` component and `getMarkdownTheme()` are resolved from the installed Pi coding-agent package;
- discovery supports both symlinked npm bins and regular mise wrappers with packages under `lib/node_modules`;
- wrapper scripts are inspected for an embedded coding-agent package path as an additional fallback;
- the module-load TTY check is removed, so renderer selection does not happen before interactive mode is ready;
- Pi TUI is declared as an optional peer dependency beside the Pi coding-agent host;
- non-Pi hosts retain a deterministic fallback with a visible diagnostic rather than silently rendering raw Markdown; and
- deterministic regressions verify host dependency resolution and actual Markdown-component construction.

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
Deterministic tests:  257 passed, 0 failed
CLI smoke workflow:   passed
Acceptance syntax:    passed
git diff --check:     passed
Package dry-run:      passed
```

The package dry-run reports:

```text
Package:          atelier-prototype@0.14.0-alpha.16
Files:            424
Compressed size:  468,057 bytes
Unpacked size:    2,189,533 bytes
```

## Verification boundary

The available build environment did not contain a real `jj`, macOS `sandbox-exec`, or Linux `bwrap`
binary. Exact Git recovery is exercised against real Git repositories. Jujutsu operation recovery and
sandbox command construction are covered by deterministic fixtures and fail-closed tests; live Jujutsu,
Seatbelt, Bubblewrap, codesearch, Beads, and Pi/Bun checks remain the responsibility of the pinned mise
and live-conformance environments.

## Release classification

`0.14.0-alpha.16` remains an interactive alpha. Workspace containment and exact recoverability now form
the sole filesystem authority, but shell effect analysis remains intentionally conservative for arbitrary
interpreters, scripts, build systems, and dynamically computed effects. Those cases require one concrete
approval unless their effects can be bounded and recovered.
