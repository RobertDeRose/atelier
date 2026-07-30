# Build Report — Atelier 0.14.0-alpha.11

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

## Alpha.11 authorization correction

Alpha.11 completes the workspace-recoverability migration rather than layering it over the earlier
granular permission system:

- the legacy policy engine, permission grants, permission profiles, remembered approvals, active
  permission table, and filesystem capability bundle are removed;
- reviewed plan execution metadata remains only as workflow and task constraints;
- the canonical startup directory or explicit `--workspace` is the immutable session workspace;
- structured tools, model Bash, and direct user Bash share one effect-analysis and workspace-policy path;
- the Bash executor requires a matching pre-execution authorization token;
- Git checkpoints preserve and verify exact scoped index and worktree state, including partially staged
  files, flags, modes, renames, symlinks, ignored files, and untracked files;
- Jujutsu checkpoints capture and restore the native operation and verify the working-copy identity;
- checkpoints are atomic, size-bounded, externally stored, and associated with their tool call and Pi
  session; and
- old trust state is ignored while the ledger migration deletes legacy permission storage.

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
Package:          atelier-prototype@0.14.0-alpha.11
Files:            415
Compressed size:  452,503 bytes
Unpacked size:    2,120,475 bytes
```

## Verification boundary

The available build environment did not contain a real `jj`, macOS `sandbox-exec`, or Linux `bwrap`
binary. Exact Git recovery is exercised against real Git repositories. Jujutsu operation recovery and
sandbox command construction are covered by deterministic fixtures and fail-closed tests; live Jujutsu,
Seatbelt, Bubblewrap, codesearch, Beads, and Pi/Bun checks remain the responsibility of the pinned mise
and live-conformance environments.

## Release classification

`0.14.0-alpha.11` remains an interactive alpha. Workspace containment and exact recoverability now form
the sole filesystem authority, but shell effect analysis remains intentionally conservative for arbitrary
interpreters, scripts, build systems, and dynamically computed effects. Those cases require one concrete
approval unless their effects can be bounded and recovered.
