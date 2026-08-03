# ADR-0042: Separate Transient Progress from Durable Status and Gate Plan Retrieval on Review

## Status

Accepted.

## Date

2026-08-03.

## Context

The alpha.44 guided evidence passed all five acceptance steps but exposed three
presentation and evidence-quality problems:

- transient phase text was inserted into the footer's durable `mode:` field, making
  workflow state harder to read rather than providing a distinct progress signal;
- an exact planning objective that named both implementation files still issued a
  semantic provider query because the generated, unreviewed plan scaffold was
  treated as reviewed-plan retrieval input; and
- macOS extended attributes, including `LIBARCHIVE.xattr.com.apple.provenance`, were
  retained in guided evidence archives despite AppleDouble suppression.

The durable footer, transient progress, reviewed plan, and generated plan scaffold
have different authority and lifecycle. They must not share one representation or
retrieval role.

## Decision

- Keep the two-line Atelier footer exclusively for durable model, context, workflow,
  task, VCS, and intelligence state. Transient work never replaces the `mode:` value.
- While Pi is idle, render one animated, in-place progress row above the editor. The
  row is a single line, is removed on completion or replacement, and does not enter
  transcript scrollback. During an agent or tool turn, use Pi's native working
  indicator instead of adding another row.
- Continue yielding one event-loop turn after publishing progress and continue
  recording `ui.phase_changed` evidence, now identifying either the single-line
  spinner or native working-indicator surface.
- Treat `reviewed_plan` as a repository-retrieval source only when the plan hash
  equals the durable `reviewedPlanHash`. A generated or edited-but-unreviewed plan
  scaffold cannot broaden retrieval.
- Preserve exact-file direct-read planning. Normalize Markdown backticks out of
  semantic query text so identifier-only objectives remain useful to providers.
- Prefer GNU tar as `gtar` when available because it does not archive xattrs unless
  requested. Otherwise build evidence archives with the platform-supported
  `--no-xattrs`,
  `--no-mac-metadata`, `--no-acls`, and `--no-fflags` tar options, discovered by
  executable capability probes rather than help-text matching. Also set
  `COPYFILE_DISABLE=1` and `COPY_EXTENDED_ATTRIBUTES_DISABLE=1`. Allow
  `ATELIER_ARCHIVE_TAR` to select an explicit compatible tar binary.
- Require automated version tests to import `ATELIER_PRODUCT_NAME` and
  `ATELIER_VERSION` from the exact TypeScript source specifier
  `../packages/core/src/version.ts` before focused validation can run.

## Consequences

- Users see a familiar one-line spinner without losing the durable workflow mode or
  expanding message scrollback.
- Idle slash commands and streaming agent work use different Pi-appropriate
  surfaces but retain one phase-evidence contract.
- Exact file-scoped planning avoids irrelevant provider latency even after Atelier
  has generated its initial plan template.
- Reviewed plans can still contribute bounded retrieval context after ManualEdit
  establishes their authority.
- Semantic providers receive cleaner identifier text when discovery is required.
- Guided and live archives no longer carry macOS provenance xattrs when GNU tar is
  installed or the host tar
  supports the corresponding suppression flags.
