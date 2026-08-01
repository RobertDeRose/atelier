# Manual Acceptance Corrections — historical alpha.10 evidence

> **Historical record:** The behaviors below explain the alpha.5–alpha.10 correction path. Alpha.11
> replaces permission grants and the unconfined-shell approval model with ADR-0032 workspace
> recoverability, exact checkpoints, and shared sandbox-aware shell execution.

This document records the disposition of the complete alpha.5 manual-testing archive. The archive includes
the Pi transcript, external SQLite ledger, trust records, exact approval and permission state, Beads data,
Jujutsu status/diff evidence, and CLI cancellation output. It distinguishes product defects from procedure
errors and from observations the evidence did not prove.

## Alpha.28 live-footer correction

The alpha.27 guided run exposed a stale runtime value in Atelier's custom Pi footer: Pi changed its
thinking level from `high` to `off`, while the footer retained the value captured when the Core was opened.
The audit found related refresh gaps for model changes, direct user shell, interactive editor/navigation
returns, failed or completed validations, commits, task transitions, and source changes made outside Pi while
it was idle. Alpha.28 now:

- consumes Pi `thinking_level_select` and `model_select` events directly;
- serializes footer refreshes so a slower older observation cannot overwrite a newer one;
- re-observes Git or Jujutsu state after typed tools, direct `!` shell, commits, closure, interactive children,
  and every subsequent user interaction;
- records provider/index lifecycle state and marks intelligence `degraded` when current source revisions no
  longer match the indexed baseline;
- restores Pi's built-in footer rather than retaining stale Atelier values when repository observation fails; and
- extends guided Step 1 and deterministic coverage for immediate thinking/model refresh and source/index drift.

The footer remains intentionally event-driven rather than polling external processes continuously. A change
made completely outside Pi while Pi is idle becomes visible on the next Pi input, command, tool result, or
agent lifecycle event.

## Alpha.27 guided-evidence corrections

The alpha.26 guided evidence exposed four current issues that are distinct from the historical
permission-model findings below:

1. **Step 2 described the wrong policy.** Typed mutations were correctly denied in investigate mode, while
   dirty tracked, untracked, and ignored deletion was checkpointed and allowed. Alpha.27 documents the
   actual matrix and reserves explicit rejection for secret reads, outside-workspace effects, and
   indeterminate commands.
2. **The harness restored only one checkpoint.** Recovery output is newest-first, but the script selected
   one terminal entry. Alpha.27 prints and restores every path-scoped checkpoint and verifies exact file
   contents before accepting the step.
3. **Step 4 asked the tester to repair planner output.** Alpha.27 injects the exact configured validation
   catalog into planning and treats any generated `typecheck` substitution as a failure rather than a
   manual-edit task.
4. **Post-approval retrieval drift revoked an untouched execution.** Retrieval revisions remain durable
   provenance, but they are not task-execution authority after approval. Alpha.27 records drift once and
   preserves execution while source, workspace, provider, task mapping, and reviewed constraints remain
   exact.

A deterministic regression now covers exact approval, later retrieval, implementation, pause, a blocked
`// pause-probe` typed edit, resume, and cancellation. A separate guided regression restores all Git
checkpoints and verifies the restored dirty tracked, untracked, and ignored paths.

## Evidence-supported behavior retained

The manual run confirmed several boundaries that alpha.6 preserves:

- pre-trust `doctor` was observational and did not create runtime state;
- runtime SQLite state was external to the repository;
- adversarial generic-shell commands were authorized as unconfined `command.execute` operations requiring
  one-operation approval;
- rejecting exact approval performed no Beads mutation and installed no execution grant or permissions;
- accepting the transaction created and claimed one approved-plan task;
- typed in-repository writes were authorized independently from generic Bash;
- the first Bash command ran only after one-operation approval;
- the second Bash command was denied and did not execute; and
- external CLI cancellation revoked the execution grant and linked permissions while preserving the
  in-progress Beads task and working-copy changes.

The shell boundary therefore passed. The stop-ship failure began after denial, when Atelier repeatedly
converted incomplete settled state into another model turn.

## Confirmed product defects and corrections

### 1. Denial and abort could force an endless agent loop

**Evidence:** Denying the second Bash validation produced `Operation aborted`; every subsequent
`agent_settled` event injected another `[Atelier completion guard]` follow-up, restarted the model, and
returned the UI to `Working...`.

**Correction:** `agent_settled` never sends a Pi `followUp`. It may emit one passive, deduplicated notice.
An incomplete task may remain active while Pi is idle. The authoritative predicate is enforced only when
closure or automatic task advancement is requested.

### 2. Stop, pause, and cancellation were conflated

**Evidence:** `/cancel` called `waitForIdle()` while the completion loop prevented Pi from remaining idle.
The user wanted to stop the current turn, but the only durable escape revoked the complete execution.

**Correction:** Atelier now separates:

- `/atelier-stop`: abort only the current model/tool turn;
- `/atelier-pause`: durably keep the task and grants but deny agent mutation;
- `/atelier-resume`: restore a paused execution without starting a model turn; and
- `/cancel`: atomically revoke the execution and linked grants while leaving the provider task open.

None waits for an idle state that Atelier controls.

### 3. The supposedly exact capability bundle was repository-wide

**Evidence:** The reviewed task named two files, excluded dependencies, and named one focused validation.
The alpha.5 bundle nevertheless granted whole-repository `file.write`, `dependency.modify`,
`validation.full_suite`, and local-change authority.

**Correction:** Every task must include a machine-readable `execution` object in its `atlr:task` metadata.
Preparation derives capabilities only from exact reviewed paths, named validations, and explicit booleans.
Dependency and full-suite capabilities are absent unless explicitly enabled. When closure requires
validation and configured required checks exist, every approvable task must name at least one of them.
Missing or inconsistent contracts fail preparation.

### 4. Approval did not disclose the authority being granted

**Evidence:** The dialog showed plan/reconciliation identity but not the broad permissions installed by
approval.

**Correction:** Pi and CLI approval summaries now list, per plan task:

- writable paths;
- dependency manifests or `not permitted`;
- named focused validations;
- full-suite permission or `not permitted`;
- path-scoped local-change permission; and
- explicit exclusions for generic shell, publication, external effects, and out-of-scope paths.

The complete projection is hashed into the exact transaction.

### 5. Advertised routine capabilities had no model-facing typed route

**Evidence:** The prompt claimed declared validation and local-change operations were typed and authorized,
but Pi exposed only code-intelligence tools. The model therefore used Bash for validation.

**Correction:** Pi now registers and activates:

- `atlr_state`;
- `atlr_validate`;
- `atlr_commit`; and
- `atlr_task_close`.

File and dependency writes continue through Pi's typed `write`/`edit` tools. Task update/link capabilities
are not minted because no corresponding typed model tools exist. Declared validation is never represented
as generic shell authority.

### 6. Validation failure could look like successful tool execution

**Evidence:** Alpha.5 already mislabeled one failed Bash operation as interrupted. A typed validation tool
must not recreate the inverse inconsistency by returning a normal successful tool result containing
`failed` text.

**Correction:** A declared validation with `failed` evidence causes the typed model tool to fail. An
explicitly aborted validation returns a structured `interrupted` result rather than converting the user
cancellation into a generic validation failure. Durable evidence remains available in both cases.

### 7. Tool outcome classification searched arbitrary output text

**Evidence:** A normal test exited with code 1, but its Node output contained `AbortSignal` and
`cancelled 0`; the ledger recorded it as interrupted.

**Correction:** interruption is derived from structured abort state or the exact tool-owned terminal
sentinel. Nonzero tool errors remain failed regardless of words in stdout/stderr.

### 8. Cancellation left workflow lifecycle state active

**Evidence:** CLI cancellation revoked grants and changed mode, but the workflow row remained
`status: active`, `checkpoint: executing`.

**Correction:** pause, resume, cancel, invalidation, and completion update workflow run, execution grant,
linked permissions, current-task state, pause state, and durable events in one SQLite transaction.
Repeated execution validation is idempotent and does not append fabricated `execution.resumed` events.

### 9. Closure diagnostics described the wrong missing condition

**Evidence:** `manual-acceptance` was configured, required, and path-matched, but no focused selection had
been recorded. Working State said no required validation applied.

**Correction:** closure readiness exposes typed blockers and distinct messages for:

- `validation_selection_missing`;
- `validation_no_required_match`;
- `validation_configuration_missing`;
- missing, stale, failed, or interrupted evidence;
- missing exact diff review;
- missing local change; and
- unacceptable repository state.

CLI, Pi, Working State, and task closure consume the same result.

### 10. Mutation evidence attributed all dirty paths to each operation

**Evidence:** Editing only `packages/core/src/version.ts` reported both it and the already-dirty test file.

**Correction:** execution evidence stores before/after path fingerprints and separates newly changed,
further modified, removed, and pre-existing unchanged dirty paths. `changedPaths` now describes the
individual operation.

### 11. Workflow metadata invalidated source evidence

**Evidence:** editing `.atelier/PLAN.md` changed Jujutsu change/operation identity and invalidated retrieval,
even though application source had not changed.

**Correction:** repository snapshots now contain two identities:

- raw VCS identity for diagnostics and recovery; and
- source base/fingerprint for approval, retrieval, validation, and execution freshness.

`.atelier`, `.beads`, `.codesearch`, `.octocode`, and related provider metadata affect raw identity but not
source freshness.

### 12. A task commit could sweep `.atelier/PLAN.md` into implementation history

**Evidence:** the stopped workspace contained `.atelier/PLAN.md` plus the two task files in one Jujutsu
working change. Alpha.5's unscoped `jj describe`/`jj new` path would have finalized them together.

**Correction:** typed Git and Jujutsu local-change creation accepts only source paths authorized by the
active task contract. Workflow metadata, provider state, and unrelated staged changes remain outside the
task change. Commit preview and final-diff review reject source changes beyond reviewed scope.

### 13. `atlr init --beads` was destructive when repeated

**Evidence:** the archived history contained a later `bd init` that removed tracked hooks and interaction
records.

**Correction:** Atelier checks provider status first. An initialized Beads workspace is a no-op except for
permission hardening. `.beads` is set to mode 0700 where supported. Reinitialization is not inferred from
`--beads`.

### 14. Explicit per-turn tool prohibitions were advisory only

**Evidence:** the user said not to use Bash, validate, commit, close, or continue; the model requested Bash
and validation anyway.

**Correction:** Pi extracts explicit current-turn prohibitions for Bash, validation, local-change creation,
and task closure. Those tools are blocked before policy approval, so an existing capability cannot weaken
the latest user instruction into another confirmation dialog. The prompt also states that authorization
is not instruction. Natural-language `stop after` remains guidance; task closure and user-control
boundaries provide the enforceable state transitions.

### 15. Explicit human symbol lookup was inventory-gated

**Evidence:** `/code-symbols AtelierCore` initially returned `no_provider_call` because an unrelated prior
semantic query had not marked that identifier unresolved.

**Correction:** explicit slash-command and CLI symbol requests perform a direct bounded lookup or exact
cache reuse. The autonomous model tool retains inventory-first gating.

### 16. Symbol identity did not converge

**Evidence:** the provider returned `class AtelierCore`, helper signatures, and `block (12 lines)`, while
the inventory simultaneously listed `AtelierCore` unresolved. Cache reuse did not repair the state.

**Correction:** canonical identifier, display signature, kind, and location are separated. Generic chunk
labels are discarded, exact definitions rank first, cache reuse reconciles state, and one canonical symbol
cannot be both resolved and unresolved in the same repository scope.

### 17. Identifier extraction accepted expressions and workflow nouns

**Evidence:** unresolved candidates included `ATELIER_PRODUCT_NAME = "Atelier`, `ATLR`, `CLI`, and
`manual-acceptance`.

**Correction:** quoted spans are tokenized conservatively; assignments, malformed strings, task IDs,
validation names, and generic workflow nouns do not become exact-symbol phases.

### 18. Known-path work was forced through semantic discovery

**Evidence:** the objective named both files, yet the system required semantic discovery and consumed
provider budget before direct reads.

**Correction:** known exact paths are direct-read decisions. Semantic retrieval remains preferred for
unknown locations and cross-file concepts, not as a ritual prerequisite for trivial local work.

### 19. Passive lifecycle events caused retrieval and resume churn

**Evidence:** every forced follow-up rebuilt Working State, revalidated execution, and produced repeated
resume/retrieval records.

**Correction:** execution restoration is idempotent, passive settled notices do not start retrieval, and
current source-qualified inventory is reused unless task/source/provider scope actually changes.

### 20. Planning and provider presentation obscured the small task

**Evidence:** the agent split one constant plus its test into multiple tasks and `/code-status` printed a
large provider operating manual.

**Correction:** planning requests the smallest independently deliverable task graph and keeps tests with
their implementation unless separately releasable. Interactive provider status is concise while
structured diagnostics retain complete detail.

## Test-procedure defects corrected

### Trust-store snapshot truncated the authoritative file

The previous procedure piped the trust store through `tee` to the same path, truncating it. The safe
legacy procedure copied it to `trusted-projects-snapshot.json`; this no longer applies because Atelier trust persistence was removed.

### Temporary workspaces were lost after reboot

The revised guide uses a persistent workspace under `~/workspace/scratch`, stores its path in
`~/.atelier-manual-current`, and supplies one resume block.

### Setup state was mixed with task evidence

The revised guide establishes a clean setup baseline before plan review, so task diff, validation, and
cleanliness evidence do not include initialization.

### The first Bash execution was not a permission bypass

The model violated the user's requested tool choice, but Atelier prompted and the user approved the first
one-operation Bash grant. The second request was denied and did not execute. The correct split is:

```text
Shell authorization boundary: PASS
Agent instruction compliance: FAIL
Post-denial user control: STOP in alpha.5, corrected in alpha.6
```

## Not established by the archive

- The isolated `Usage: /code-search QUERY` warning was not attributable to one reproducible event and
  remains a watch item.
- Prompt changes cannot guarantee model obedience; typed policy and explicit denial remain authoritative.
- The archive did not complete the final validation/commit/diff-review/closure sequence because stopping
  at the user-control defect was correct.

## Alpha.6 regression gate

The deterministic suite includes evidence-derived checks that:

1. denial starts no follow-up turn;
2. repeated `agent_settled` events produce one passive notice and zero synthetic messages;
3. an incomplete task may remain idle;
4. stop, pause, resume, and cancel remain reachable while active;
5. cancellation atomically closes workflow lifecycle state;
6. output containing `AbortSignal` or `cancelled 0` does not imply interruption;
7. exact plan paths produce exact write grants;
8. excluded dependency and full-suite authority is absent;
9. approval displays every effective capability and exclusion;
10. model validation runs through a typed tool and failed validation is a failed tool operation;
11. explicit no-Bash/no-validation/no-commit/no-close constraints block before prompting;
12. per-tool evidence attributes only its own path delta;
13. workflow metadata does not change source freshness;
14. Git and Jujutsu task changes contain only approved source paths;
15. repeated Beads initialization preserves provider files and data;
16. active execution revalidation is idempotent;
17. human symbol lookup performs direct lookup;
18. symbol inventory converges on canonical identifiers;
19. known-path planning does not require semantic discovery; and
20. validation-required tasks cannot approve without naming a configured required check.

## Alpha.8 automated-acceptance corrections

The alpha.7 automated run confirmed narrow capabilities, source-scoped commits, validation freshness, shell denial, and execution revocation, but exposed four product defects and several harness false passes:

- `requireCleanGit` reported success while tracked `.atelier/PLAN.md` and `.beads/interactions.jsonl` remained dirty.
- A typed read of a nonexistent approved in-root file requested exceptional approval instead of allowing the read tool to report that the file was absent.
- `nextAction` recommended validation when the only remaining blocker was exact diff review.
- Completed Working State described the workflow as blocked because no active execution grant remained.
- Task-close evidence ignored provider/workflow metadata mutations.
- The headless symbol test did not perform semantic discovery, ordinary phases ignored tool errors, and final raw Jujutsu status was collected but not asserted.

Alpha.8 separates source cleanliness from whole-repository cleanliness, finalizes workflow/provider metadata in a separate local change during typed closure, resolves nonexistent targets through their nearest existing ancestor, derives guidance from structured blocker codes, reports completed workflows as completed, and ships the corrected live-acceptance harness as `scripts/live-acceptance.sh`.
