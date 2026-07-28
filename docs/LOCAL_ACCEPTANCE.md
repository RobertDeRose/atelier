# Local Acceptance Workflow — 0.14.0-alpha.2

This is the maintainer gate for the trusted plan-to-commit workflow. Deterministic acceptance is
mandatory. Live external-provider acceptance is separate because it depends on installed tools and an
interactive terminal.

## Deterministic gate

```sh
mise install
mise run install
npm run check
npm pack --dry-run
```

The deterministic suite covers:

- external project trust and observational diagnostics;
- adversarial shell classification and unconfined authorization;
- symlink-safe typed path confinement;
- exact plan/reconciliation/source/retrieval/capability approval;
- rejection with zero provider mutation;
- atomic task claim and capability installation;
- mutation success/failure/interruption evidence;
- required validation, staleness, final-diff review, local change, and clean closure;
- Git staged/untracked evidence and explicit provider failure;
- restart invalidation, legacy fail-closed migration, and cancellation;
- real secondary-repository snapshots and drift invalidation;
- isolated concurrent Pi sessions and awaited shutdown;
- stable build/launcher/package metadata;
- smoke cleanup after success, failure, and cancellation.

The fake-provider fixture is deterministic evidence only. Do not describe it as a live Jujutsu, Beads,
codesearch, or Pi/Bun result.

## Disposable live workspace

Never perform the live gate in the primary checkout.

```sh
parent="$(mktemp -d -t atelier-live-acceptance.XXXXXX)"
git clone --no-hardlinks . "$parent/atelier"
cd "$parent/atelier"
jj git init --colocate
mise install
mise run install
npm run build
```

Before trust, verify diagnostics are observational:

```sh
atlr doctor
atlr trust status
```

Review the project configuration, then trust and initialize:

```sh
atlr trust add --yes
atlr init --beads
atlr config validate
```

If the validation manifest has no required check, configure one before continuing. For this repository:

```json
{
  "closurePolicy": {
    "requireValidation": true,
    "requireFinalDiffReview": true,
    "requireLocalChange": true,
    "requireCleanGit": true
  },
  "validations": {
    "acceptance": {
      "command": ["npm", "run", "check"],
      "category": "full",
      "required": true
    }
  }
}
```

## Interactive Pi gate

```sh
atlr launch
```

### 1. Plan and review

Run `/plan <small objective>`, allow provider-first discovery, and verify raw inspection remains available
as an advisory fallback rather than a routing denial. Planning may update only the designated plan
through its typed plan path.

Run `/review`, edit one structured plan field, save, and exit. Verify the durable `ManualEdit`, parser
diagnostics, before/after hashes, structural changes, provider identity, reconciliation digest, source
bindings, retrieval bindings, and proposed capability bundle.

### 2. Reject, then approve

Run `/approve` and reject once. Verify:

- no provider mutation;
- no task claim;
- no execution or capability grants;
- mode remains `plan`.

Run `/approve` again and accept the unchanged exact transaction. Verify reconciliation converges, one
approved-plan task is claimed, mode becomes `act`, and typed task capabilities are installed atomically.
There should not be a second prompt for an ordinary typed in-root edit. Generic Bash must still request a
single-operation approval and must be described as unconfined.

### 3. Execute and record evidence

Perform one typed source edit. Verify Working State records authorization, before/after snapshots,
changed paths, and success/failure/interruption accurately. Test at least one denied symlink/out-of-root
path. Do not use a denied operation to fabricate successful evidence.

### 4. Commit, validate, review, close

Create the local change:

```text
/commit feat: complete acceptance task
```

Run:

```text
/validate plan
/validate focused
/evidence
/review-diff
/close completed and verified
```

Verify `/review-diff` corresponds to the exact approved baseline diff. Task closure must fail before all
required evidence exists and succeed only when validation is current, the exact diff is reviewed, a local
commit/change exists, and configured repository cleanliness holds.

Change source after validation or diff review and verify the relevant evidence becomes stale before
closure.

### 5. Restart and cancellation

Quit and relaunch Pi while a task is active. Verify task, approval, capability grants, mutation evidence,
validation freshness, repository bindings, and next action reconstruct without conversation history.

Run `/cancel <reason>` and verify execution-linked capabilities are revoked without changing task status or
repository content. Later approved-plan work must require explicit `/execute [task-id]` confirmation.

### 6. Multi-repository gate

Create a second disposable repository, approve it with:

```sh
atlr trust workspace add /path/to/secondary --yes
```

Add it to `.atelier/workspace.json`. Verify both roots show real revisions. Mutate the secondary root and
verify active execution or resume fails closed rather than reusing old evidence.

## Live conformance workflow

`.github/workflows/live-conformance.yml` separates:

- public-tool Jujutsu and codesearch checks;
- self-hosted Beads and Pi/Bun checks.

Record exact tool versions, operating system, commit/tag, and command output. An unavailable integration
is “not run,” not a pass. Remove the disposable workspace after evidence is captured.
