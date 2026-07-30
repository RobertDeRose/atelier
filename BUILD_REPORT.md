# Build Report — Atelier 0.14.0-alpha.14

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

## Alpha.14 persistent report correction

Alpha.14 keeps the responsive two-line footer and replaces transient structured Pi notifications with
persistent TUI-only Markdown reports:

- `/status` and `/code-status` render compact tables;
- `/state` renders durable Working State headings and lists;
- code search and symbol lookup separate definitions, references, source, tests, documentation, and
  generated results;
- changed paths, ready tasks, validation plans/results, and evidence remain visible in scrollback;
- reports are stored as custom session entries and do not participate in LLM context;
- intentionally disabled code intelligence is neutral rather than reported as offline; and
- thinking levels use normal text contrast instead of the theme's dim color.

The guided verification harness clears every direct Pi transition, labels the intentional VCS and
intelligence state, stores detailed instructions outside the TUI viewport, and gathers authoritative
post-session evidence without a pseudo-terminal recorder.

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
Deterministic tests:  254 passed, 0 failed
CLI smoke workflow:   passed
Acceptance syntax:    passed
git diff --check:     passed
Package dry-run:      passed
```

The package dry-run reports:

```text
Package:          atelier-prototype@0.14.0-alpha.14
Files:            424
Compressed size:  465,009 bytes
Unpacked size:    2,176,406 bytes
```

## Verification boundary

The available build environment did not contain a real `jj`, macOS `sandbox-exec`, or Linux `bwrap`
binary. Exact Git recovery is exercised against real Git repositories. Jujutsu operation recovery and
sandbox command construction are covered by deterministic fixtures and fail-closed tests; live Jujutsu,
Seatbelt, Bubblewrap, codesearch, Beads, and Pi/Bun checks remain the responsibility of the pinned mise
and live-conformance environments.

## Release classification

`0.14.0-alpha.14` remains an interactive alpha. Workspace containment and exact recoverability now form
the sole filesystem authority, but shell effect analysis remains intentionally conservative for arbitrary
interpreters, scripts, build systems, and dynamically computed effects. Those cases require one concrete
approval unless their effects can be bounded and recovered.
