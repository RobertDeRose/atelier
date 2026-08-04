# Historical Atelier Remaining Issues and Roadmap — Alpha.9

> This page is retained as historical planning evidence. It is not the current
roadmap; use Beads and [Planned features](../../planned-features.md) instead.

Against alpha.9, these are the remaining issues worth addressing. Some are confirmed implementation risks; others are unfinished product areas already acknowledged in the repository.

## Recommended alpha.10 scope

### 1. Replace the permission and trust system with a workspace-boundary and recoverability policy

Convert Atelier's current permission system into a minimal, deterministic, workspace-boundary and recoverability policy.

### Objective

Replace Atelier's current granular permission, trust, and approval system with a predictable policy that asks the user only before operations Atelier cannot reliably recover.

Remove Atelier's `/atelier-trust` command and its associated trust-management model.

Do not replace it with another trust command, trust database, permission matrix, command allowlist, or machine-learning classifier.

The core rule is:

> Automatically allow operations whose effects remain inside the Atelier workspace and are either read-only or recoverable. Ask only before operations that may cause irreversible loss, expose likely secrets, require privilege escalation, or escape the workspace boundary.

This should behave similarly to OpenCode's workspace-oriented defaults, strengthened by VCS-backed recoverability.

### Workspace definition

The Atelier workspace is established automatically when Atelier starts.

By default, it is the canonical filesystem path of the directory from which Atelier was launched.

For example:

```text
cd ~/workspace/personal/atelier
atlr
```

The workspace is:

```text
~/workspace/personal/atelier
```

after absolute-path and canonical-path resolution.

There is no separate Atelier trust decision.

There is no `/atelier-trust` approval step.

There is no persistent list of trusted projects required for normal operation.

The user explicitly chooses the workspace by choosing the directory from which Atelier starts.

#### Requirements

1. Capture the process startup working directory before any later directory changes.
2. Convert it to an absolute canonical path.
3. Store it as immutable session workspace state.
4. Use that workspace root for all permission decisions during the session.
5. Do not silently expand the workspace to the VCS repository root when Atelier was started in a subdirectory.
6. Do not silently narrow the workspace when commands change directory.
7. Child processes inherit the same workspace boundary.
8. A future explicit `--workspace <path>` option may override the startup directory, but this is not required unless already supported.
9. Do not introduce interactive workspace approval.
10. Do not persist workspace permission state between sessions unless necessary for a separate non-permission feature.

### Relationship to Pi `/trust`

Pi's `/trust` command governs whether Pi loads project-local configuration, extensions, skills, prompts, themes, and packages.

It is not Atelier's filesystem permission system.

Atelier must not:

* override Pi's `/trust`;
* alias `/atelier-trust` to Pi's `/trust`;
* treat Pi project trust as permission to modify files;
* write Atelier permission state into Pi's trust database;
* require Pi project trust before applying Atelier's workspace policy;
* add a second trust UI that duplicates Pi's project trust.

Remove Atelier's `/atelier-trust` command because it is no longer needed.

Pi `/trust` remains available for Pi's own project-resource loading behavior.

Atelier's workspace is selected automatically from its startup directory regardless of Pi's trust state.

Document the distinction succinctly:

```text
Pi /trust:
  Controls loading project-local Pi resources.

Atelier workspace policy:
  Controls filesystem operations during the current Atelier session.
  The workspace defaults to the directory where Atelier was started.
```

Investigate whether Atelier currently hooks Pi's `project_trust` event.

Remove that integration if it exists solely to implement Atelier filesystem permissions.

Retain a `project_trust` hook only if Atelier itself provides project-local Pi resources whose loading genuinely depends on Pi trust. Such handling must remain independent of filesystem-operation permissions.

### Terminology

Use these terms consistently.

#### Workspace

The canonical directory from which Atelier was started, or an explicit workspace path supplied at startup.

#### Read-only

An operation that observes state without changing persistent filesystem state.

#### Create

An operation that creates a path that does not currently exist.

#### Mutate

An operation that changes an existing path without inherently discarding its complete previous contents.

#### Destructive

An operation that deletes, truncates, overwrites, replaces, resets, or otherwise loses existing state.

#### Recoverable

Atelier can restore the exact previous state from VCS or from a successfully created Atelier checkpoint.

#### Tracked

A path represented by the active VCS.

#### Clean tracked

A tracked path whose current state is fully recoverable directly from VCS.

#### Dirty tracked

A tracked path containing staged, unstaged, partially staged, mode, rename, symlink, or other uncommitted changes not recoverable directly from the current VCS revision.

#### Untracked

An existing path whose contents are not represented by the active VCS.

#### Ignored

A path excluded by VCS ignore rules. Ignored does not mean disposable or secret.

#### Potential secret

A path identified by explicit path rules as likely containing credentials or sensitive configuration.

### Required default policy

Implement this policy.

| Operation                       | Target or state                                     | Default                                                                 |
|---------------------------------|-----------------------------------------------------|-------------------------------------------------------------------------|
| Read                            | Non-secret path inside workspace                    | Allow                                                                   |
| Read                            | Potential-secret path inside workspace              | Ask                                                                     |
| Read                            | Path outside workspace                              | Ask                                                                     |
| Create                          | New path inside workspace                           | Allow                                                                   |
| Create                          | New path outside workspace                          | Ask                                                                     |
| Mutate                          | Clean tracked path inside workspace                 | Allow                                                                   |
| Mutate                          | Dirty tracked path inside workspace                 | Checkpoint, then allow                                                  |
| Mutate                          | Existing untracked or ignored path inside workspace | Allow when previous contents are preserved; otherwise checkpoint or ask |
| Delete                          | Clean tracked path inside workspace                 | Allow                                                                   |
| Delete                          | Dirty tracked path inside workspace                 | Checkpoint, then allow                                                  |
| Delete                          | Existing untracked or ignored path inside workspace | Ask unless Atelier has checkpointed the exact previous state            |
| Overwrite or truncate           | Existing untracked or ignored path inside workspace | Ask unless Atelier has checkpointed the exact previous state            |
| Any persistent operation        | Outside workspace                                   | Ask                                                                     |
| Privilege escalation            | Anywhere                                            | Ask                                                                     |
| Potential-secret access         | Anywhere                                            | Ask                                                                     |
| Unknown or indeterminate effect | Anywhere                                            | Ask                                                                     |

The policy should optimize for very few approvals during normal repository work.

Routine reading, editing, patching, testing, formatting, refactoring, file creation, and deletion of recoverable tracked files inside the workspace should not prompt.

### Core decision rule

Reduce the permission system to three questions:

1. Is every affected path inside the session workspace?
2. Is the operation read-only, or can Atelier restore the exact previous state?
3. Does the operation access likely secret material or require privilege escalation?

The conceptual policy is:

```text
inside workspace
AND not protected-secret access
AND (read-only OR recoverable)
    => allow

otherwise
    => ask
```

Reserve `Deny` for operations forbidden by an explicit invariant or platform restriction.

Use `Ask` for legitimate operations that require user authorization.

### No permission profiles

Remove concepts equivalent to:

* trusted project;
* trusted directory;
* permission mode;
* permission profile;
* command allowlist;
* command denylist;
* per-tool approval mode;
* read permission;
* write permission;
* edit permission;
* shell permission;
* remembered approval;
* always allow this command;
* always allow this repository;
* global trusted workspace;
* session trust escalation.

Do not retain old abstractions merely for backward compatibility.

Atelier should have one default policy with minimal, explicit configuration only where necessary.

### Effect classification

Classify intended effects rather than classifying commands only by executable name.

Commands such as these do not describe their effects reliably:

```text
python script.py
make clean
cargo test
git checkout .
find . -delete
```

Introduce or simplify toward types equivalent to:

```rust
enum EffectKind {
    Read,
    Create,
    Mutate,
    Delete,
    Execute,
    Network,
    PrivilegeEscalation,
    Unknown,
}

struct FilesystemEffect {
    kind: EffectKind,
    path: PathBuf,
}

enum PathState {
    OutsideWorkspace,
    PotentialSecret,
    Missing,
    TrackedClean,
    TrackedDirty,
    Untracked,
    Ignored,
    Unknown,
}

enum PermissionDecision {
    Allow,
    CheckpointThenAllow,
    Ask,
    Deny,
}
```

Adapt these names to Atelier's existing conventions where appropriate.

Do not introduce parallel abstractions when suitable ones already exist.

### Minimal decision logic

The policy should remain conceptually close to:

```rust
fn decide(effect: &FilesystemEffect, state: PathState) -> PermissionDecision {
    use EffectKind::*;
    use PathState::*;

    match (&effect.kind, state) {
        (_, OutsideWorkspace) => PermissionDecision::Ask,

        (Read, PotentialSecret) => PermissionDecision::Ask,
        (Read, _) => PermissionDecision::Allow,

        (Create, Missing) => PermissionDecision::Allow,

        (Mutate | Delete, TrackedClean) => {
            PermissionDecision::Allow
        }

        (Mutate | Delete, TrackedDirty) => {
            PermissionDecision::CheckpointThenAllow
        }

        (Mutate, Untracked | Ignored) => {
            PermissionDecision::Allow
        }

        (Delete, Untracked | Ignored) => {
            PermissionDecision::Ask
        }

        _ => PermissionDecision::Ask,
    }
}
```

This is illustrative, not mandatory code.

The implementation must distinguish ordinary mutation from destructive replacement.

### Destructive replacement

Treat the following as destruction of the existing destination followed by creation of new state:

```text
echo value > existing-file
truncate -s 0 existing-file
cp source existing-file
mv source existing-file
install source existing-file
cat generated > existing-file
git checkout -- existing-file
git restore existing-file
git reset --hard
jj restore
```

For an existing untracked or ignored destination, these operations may destroy unrecoverable contents and must ask unless Atelier first creates and verifies a recovery checkpoint.

Appending is not equivalent to truncating:

```text
echo value >> existing-file
```

It is still a mutation and may require effect-specific handling, but it does not inherently erase the previous contents.

### VCS recoverability

Use Atelier's VCS abstraction instead of embedding Git-specific assumptions in the policy evaluator.

Support at least Git and Jujutsu through provider interfaces.

The policy layer needs operations equivalent to:

* locate VCS state relevant to a path;
* determine whether a path is tracked;
* determine whether it is clean or dirty;
* determine whether it is ignored;
* identify staged and unstaged changes;
* identify partially staged files;
* determine whether exact prior state is recoverable;
* create a recovery checkpoint;
* verify checkpoint success;
* describe or execute restoration.

Do not assume that "tracked" means "recoverable."

A tracked file with uncommitted changes is not fully recoverable from `HEAD`.

Account for:

* staged contents;
* unstaged contents;
* partially staged files;
* file modes;
* symlinks;
* renames;
* deleted files;
* conflicted files;
* relevant metadata;
* active Jujutsu working-copy state.

### Automatic checkpoints

Use automatic checkpoints to avoid unnecessary prompts.

Before a destructive operation affecting dirty tracked paths:

1. determine every affected path;
2. capture its current state;
3. verify that the checkpoint succeeded;
4. retain a durable checkpoint identifier;
5. associate the checkpoint with the tool call and session;
6. execute only after successful checkpoint creation;
7. provide a clear recovery method.

If checkpoint creation fails, ask before continuing.

If exact restoration cannot be guaranteed, ask.

#### Git

Investigate the least intrusive mechanism that preserves:

* staged state;
* unstaged state;
* partially staged state;
* mode changes;
* renames;
* symlinks;
* affected untracked files when required.

Avoid changing visible branch history.

Avoid silently staging user changes.

Avoid leaving the worktree or index in a different state merely because a checkpoint was created.

#### Jujutsu

Prefer native working-copy snapshot and operation-log semantics.

Use Jujutsu's recoverability model where it provides stronger guarantees than a custom snapshot.

### Untracked and ignored files

Creating new files inside the workspace is allowed.

Mutating existing untracked or ignored files is allowed only when the operation preserves their previous contents sufficiently to remain recoverable or non-destructive.

Deleting, replacing, or truncating existing untracked or ignored files requires one of:

1. a verified automatic checkpoint;
2. explicit user approval.

Do not assume ignored files are disposable.

Do not automatically checkpoint very large or unsuitable paths such as:

* dependency directories;
* build outputs;
* caches;
* virtual environments;
* generated object trees;
* large binary artifacts.

Use configurable limits and ask when checkpointing is impractical.

### Secret-path policy

Use explicit path-based classification.

Do not inspect a file's contents merely to decide whether reading it requires approval.

Initial likely-secret patterns should include:

```text
.env
.env.*
*.pem
*.key
id_rsa
id_ed25519
credentials*
secrets*
.netrc
.npmrc
.pypirc
.aws/**
.ssh/**
```

Also consider common tool-specific credential paths already recognized by Atelier.

Do not classify every ignored path as a secret.

Build artifacts, dependency directories, caches, and generated files are commonly ignored and are not inherently sensitive.

Keep the secret-pattern set small, configurable, and testable.

### Workspace boundary

All path checks must be resistant to boundary escapes.

Do not rely on string-prefix matching.

Handle:

* `..` traversal;
* absolute paths;
* relative paths;
* symlinks;
* nested symlinks;
* broken symlinks;
* non-existent targets;
* external symlink targets;
* shell redirections;
* paths derived from environment variables;
* current-directory changes;
* subprocesses.

For existing targets, resolve the effective path securely.

For non-existent targets, resolve the nearest existing parent and verify that new descendants remain within the workspace.

Example escape:

```text
workspace/output -> /important/external-directory
rm -rf workspace/output/*
```

This must be treated as an operation outside the workspace.

### Structured tools

For structured tools such as:

```text
read_file
write_file
edit_file
apply_patch
move_file
delete_file
```

Atelier should know the intended effects before execution.

For each structured tool call:

1. derive the precise effects;
2. identify all affected paths;
3. resolve their workspace location;
4. classify VCS state;
5. classify secret sensitivity;
6. create recovery checkpoints when required;
7. evaluate the complete operation;
8. execute only after the policy decision.

Use Pi's `tool_call` extension event where it provides reliable pre-execution interception.

Override or replace Pi built-in tools only when the event API cannot provide the precision or enforcement required.

### Arbitrary shell commands

Static shell classification cannot be fully reliable.

Shell expansion, scripts, subprocesses, interpreters, symlinks, environment variables, redirections, nested shells, and build systems can hide effects.

Implement a layered analyzer:

1. parse straightforward commands;
2. parse arguments and redirections;
3. parse pipelines and command chains;
4. resolve obvious path targets;
5. classify known deterministic commands;
6. detect privilege escalation;
7. detect obvious external paths;
8. detect indeterminate execution;
9. ask when persistent effects cannot be bounded safely.

Examples of indeterminate execution include:

```text
python script.py
bash script.sh
sh -c "$COMMAND"
eval "$COMMAND"
make target
cargo run
npm run task
mise run task
```

Do not automatically ask merely because an interpreter or build tool is used if Atelier can enforce the workspace boundary at runtime.

However, without runtime enforcement, classify potentially persistent unknown effects conservatively.

Intercept both:

* model-issued Bash tool calls;
* direct user shell execution exposed through Pi's `user_bash` event.

### Runtime sandboxing

Treat sandboxing as the long-term mechanism that makes the simple policy reliable for arbitrary commands.

Desired execution boundary:

```text
workspace:
  read-write

external filesystem:
  read-only or unavailable

secret locations:
  hidden or approval-gated

network:
  handled by a separate policy
```

Investigate:

* Linux Landlock;
* macOS sandbox mechanisms;
* containerized execution;
* VM or micro-VM execution;
* filesystem namespaces where available.

Do not expand this plan into a full network-security architecture.

Document network access as a separate future policy concern.

The initial implementation may combine structured-tool enforcement with static shell analysis, but it must document where enforcement is incomplete.

### Privilege escalation

Ask before commands or tool calls that attempt privilege escalation, including common cases such as:

```text
sudo
doas
su
pkexec
```

Do not remember blanket approval for privileged execution.

Approval applies to the concrete operation being proposed.

### User prompts

Reduce approval prompts aggressively.

Do not prompt for:

* ordinary reads of non-secret files inside the workspace;
* creation of files inside the workspace;
* ordinary mutation inside the workspace;
* mutation of clean tracked files;
* deletion of clean tracked files;
* dirty tracked destruction made recoverable by a verified checkpoint;
* normal test, build, format, lint, and VCS inspection workflows whose effects remain bounded and recoverable.

Prompt only for the concrete unrecoverable or protected consequence.

Good:

```text
This command would delete an untracked file Atelier cannot restore:

  notes/private-draft.md

Allow once?
```

Good:

```text
This command would write outside the Atelier workspace:

  /etc/example.conf

Allow once?
```

Bad:

```text
Command requests destructive filesystem capability.
```

Bad:

```text
Bash tool requires write permission.
```

For operations involving multiple paths:

* group paths by reason;
* show a concise count and representative paths;
* permit expansion to the complete list;
* ask once for the complete operation;
* do not prompt separately for every path.

Do not provide "always allow this command" or "trust this directory" choices.

Approvals should be one-time decisions for concrete operations.

### Remove `/atelier-trust`

Delete the `/atelier-trust` command and all documentation, aliases, handlers, state, tests, and persistence used solely to support it.

Investigate:

* where `/atelier-trust` is registered;
* why it was introduced;
* what state it reads or writes;
* whether it replaced an earlier `/trust` command;
* whether other components depend on its persisted data;
* whether migration cleanup is required.

Do not restore the old `/trust` name because Pi now owns that command.

Do not introduce a renamed replacement.

Do not expose a user-facing trust-management command.

A diagnostic command may display the current session workspace as part of an existing Atelier status or diagnostics view, but it must be read-only and must not manage trust.

Example diagnostic output:

```text
Workspace: /Users/rob/workspace/personal/atelier
Source: startup working directory
Policy: workspace recoverability
```

### Configuration

Avoid permission configuration unless required.

Acceptable limited configuration may include:

* explicit startup workspace override;
* extra likely-secret path patterns;
* checkpoint size limits;
* sandbox backend selection;
* network policy handled separately.

Do not expose configurable matrices for read, write, mutate, delete, shell, or individual commands.

The default should work without setup.

### Proposed internal components

Replace the current permission implementation with four focused components:

```text
Effect Analyzer
    determines read, create, mutate, delete, and other effects

Workspace Guard
    verifies resolved paths remain inside the session workspace

Recovery Manager
    determines recoverability and creates checkpoints

Policy Evaluator
    returns allow, checkpoint-then-allow, ask, or deny
```

Keep these components small and composable.

The policy evaluator should not parse shell syntax itself.

The effect analyzer should not make approval decisions.

The workspace guard should not know about user-interface prompts.

The recovery manager should not manage trust.

### Migration requirements

Inspect the current implementation before proposing changes.

Identify:

* current permission abstractions;
* current trust abstractions;
* `/atelier-trust` command registration;
* previous `/trust` naming remnants;
* persisted trust or permission files;
* approval categories;
* remembered approvals;
* structured tool interception;
* shell interception;
* Pi extension hooks;
* VCS integrations;
* tests encoding current behavior;
* documentation describing the current system;
* compatibility layers that can be removed.

Prefer deletion over adaptation.

The migration should:

1. establish immutable session workspace state;
2. add effect classification;
3. add canonical workspace-boundary checks;
4. add VCS recoverability classification;
5. add automatic checkpoints;
6. route structured tools through the new evaluator;
7. route shell execution through the new evaluator;
8. replace abstract prompts with consequence-based prompts;
9. remove `/atelier-trust`;
10. remove persisted Atelier trust state;
11. remove obsolete permission categories;
12. remove remembered blanket approvals;
13. update documentation;
14. add focused regression and acceptance tests.

If old persisted trust data exists, either ignore it safely or delete it through an explicit migration.

Do not silently reinterpret old trusted paths as new workspace roots.

### Testing requirements

Add focused tests covering:

* startup-directory workspace selection;
* explicit startup workspace override, if supported;
* immutable workspace across directory changes;
* canonicalization;
* lexical path traversal;
* symlink escape;
* broken symlinks;
* non-existent paths beneath external symlink parents;
* ordinary workspace reads;
* potential-secret reads;
* reads outside the workspace;
* creation inside the workspace;
* creation outside the workspace;
* mutation of clean tracked files;
* deletion of clean tracked files;
* mutation of dirty tracked files;
* deletion of dirty tracked files;
* successful automatic checkpoint;
* failed automatic checkpoint;
* partially staged Git files;
* staged and unstaged changes;
* Jujutsu working-copy snapshots;
* mutation of untracked files;
* deletion of untracked files;
* deletion of ignored files;
* overwrite classification;
* truncation classification;
* multiple affected path states;
* privilege escalation;
* unknown shell effects;
* Pi `tool_call` interception;
* Pi `user_bash` interception;
* Pi `/trust` remaining independent;
* removal of `/atelier-trust`;
* removal or ignoring of old Atelier trust persistence.

Add behavioral acceptance tests proving:

1. Starting Atelier in a repository immediately establishes that directory as the workspace without prompting.
2. Reading ordinary repository files requires no approval.
3. Creating files inside the workspace requires no approval.
4. Editing tracked files requires no approval.
5. Deleting a clean tracked file requires no approval.
6. Deleting a dirty tracked file creates a checkpoint and requires no approval.
7. Deleting an untracked file asks once.
8. Overwriting an untracked file asks once unless checkpointed.
9. Reading `.env` asks once.
10. Writing outside the workspace asks once.
11. Privilege escalation asks once.
12. Routine test, format, and build workflows do not produce repetitive approvals when effects remain bounded.
13. Pi `/trust` does not alter Atelier filesystem decisions.
14. Atelier exposes no `/atelier-trust` command.
15. No Atelier trust setup is required before normal use.

### Deliverable

Produce an implementation plan, not code.

The plan must include:

1. current-state findings with concrete file references;
2. existing `/atelier-trust` behavior and dependencies;
3. proposed session-workspace architecture;
4. complete policy decision table;
5. effect-analysis design;
6. workspace-boundary design;
7. VCS recoverability and checkpoint design;
8. Pi `tool_call` and `user_bash` integration;
9. removal plan for `/atelier-trust`;
10. removal plan for old permissions and persisted state;
11. migration sequence;
12. focused test strategy;
13. behavioral acceptance criteria;
14. implementation phases in dependency order;
15. risks and unresolved questions;
16. explicit recommendations where multiple approaches remain possible.

Do not implement changes.

Do not create branches, worktrees, Beads tasks, Jira tickets, commits, or patches.

Do not expand the scope into prompt-injection detection, content moderation, package security, or a general policy language.

The intended result is a permission system that is nearly invisible during ordinary workspace development and interrupts the user only when Atelier cannot guarantee recovery or containment.

### 2. Stop inheriting the entire host environment

Repository-controlled providers and validations commonly inherit `process.env`. That can expose credentials such as API tokens, cloud credentials, SSH agent variables, signing configuration, and private service endpoints.

Correction:

* Use a minimal environment allowlist by default.
* Allow explicit environment variables per provider or validation.
* Never pass secret-shaped variables automatically.
* Show environment access in the trust and approval UI.
* Add tests proving a repository validator cannot see unrelated host secrets.

### 3. Add secret redaction and retention controls

Atelier persists tool errors, validation output, command output, retrieval data, diffs, and execution evidence. Output is bounded, but there is no comprehensive secret-redaction layer.

Correction:

* Redact tokens, passwords, private keys, authorization headers, and known credential formats before persistence.
* Keep raw output only in memory unless explicitly requested.
* Add configurable retention for:
  * Execution evidence
  * Validation evidence
  * Retrieval evidence
  * Completed workflow runs
* Add `atlr data inspect`, `atlr data prune`, and `atlr data delete`.
* Add a safe evidence export command.

This matters before wider dogfooding.

### 4. Replace synchronous subprocesses in the TUI path

The current implementation still uses `spawnSync()` for Jujutsu, Git, Beads, codesearch, Octocode, editor launch, and some CLI operations. A slow or wedged external command can freeze Pi's event loop.

Relevant implementations include:

* `packages/core/src/tasks/beads-cli-provider.ts`
* `packages/core/src/repository/jujutsu-repository-provider.ts`
* `packages/core/src/repository/git-repository-provider.ts`
* `packages/core/src/code/codesearch-provider.ts`
* `packages/core/src/code/octocode-provider.ts`
* `apps/pi-extension/src/index.ts`

Correction:

* Move provider operations to asynchronous `spawn()`.
* Support `AbortSignal`.
* Stream bounded progress.
* Kill process groups on cancellation.
* Apply separate startup, idle, and total timeouts.
* Distinguish timeout, cancellation, signal termination, and nonzero exit.

This will materially improve responsiveness and user control.

### 5. Add Beads v2 JSON-envelope compatibility

Live runs repeatedly show:

```text
bd --json output format will change in v2.0.
Set BD_JSON_ENVELOPE=1 to opt in early.
```

Atelier currently parses both complete JSON and a final JSON line after warnings, but it does not deliberately test the announced v2 envelope.

Correction:

* Set `BD_JSON_ENVELOPE=1` for Beads subprocesses.
* Normalize both legacy and envelope forms during a migration period.
* Add fixtures from the actual v2 envelope.
* Detect unsupported Beads versions clearly.
* Add a supported-version range to `doctor`.

This is a predictable future breakage and should be addressed early.

### 6. Make the custom footer composable

The alpha.9 footer fixes the misleading `detached` display, but it replaces Pi's entire footer through `setFooter()`.

The current implementation displays:

* Model
* Jujutsu or Git identity
* Atelier status
* Context percentage

It may omit or conflict with:

* Pi cost information
* Input/output token counts
* Session indicators
* Other extension footer customizations
* Future Pi footer fields

Correction:

* Preserve all useful built-in footer data where exposed.
* Detect an existing custom footer before replacing it.
* Offer a configuration option:
  * `footer = "atelier"`
  * `footer = "status-only"`
  * `footer = "disabled"`
* Prefer an upstream Pi API for replacing only the VCS segment.
* Add narrow-width rendering tests.

### 7. Consolidate CLI and Pi presentation

Several manual-test errors came from CLI text, CLI JSON, slash-command output, and Working State presenting similar concepts differently.

Correction:

* Create one typed presentation model for:
  * Plan status
  * Execution status
  * Task state
  * Repository identity
  * Closure readiness
  * Next action
* Render that model to:
  * CLI text
  * CLI JSON
  * Pi `/status`
  * Pi footer
  * Working State
* Add contract tests asserting semantic equivalence across all surfaces.

This will prevent another cycle of "the state is correct internally, but the UI says something else."

## Safety and execution work

### 8. Add a real shell sandbox

The workspace-boundary and recoverability policy should be the immediate replacement for the current approval system. Runtime sandboxing remains the long-term enforcement mechanism for arbitrary commands whose effects cannot be fully inferred statically.

Correction options:

* macOS Seatbelt profiles.
* Linux Landlock or Bubblewrap.
* Container-backed execution where appropriate.

The initial sandbox should enforce:

* Workspace read-write access.
* External filesystem read-only or unavailable.
* Secret locations hidden or approval-gated.
* A minimal environment.
* Process, CPU, memory, file-size, and time limits.
* Network policy handled separately.
* No access to SSH agents or host credential stores unless explicitly authorized.

Until this exists, arbitrary shell analysis must remain conservative when persistent effects cannot be bounded reliably.

### 9. Improve cancellation and recovery UX

The core stop, pause, resume, and cancel transitions exist, but recovery from cancellation remains awkward.

Correction:

* Show canceled tasks as resumable work.
* Add `/atelier-resume-task [id]`.
* Explain whether the previous reviewed plan and capabilities can be safely reused.
* Revalidate the source baseline before reactivation.
* Show retained changes and stale evidence before resuming.
* Avoid forcing users through complete plan approval when nothing relevant changed.

### 10. Make approval a dedicated interactive surface

The workspace-recoverability policy should remove most routine approval prompts. The remaining prompts still need a dedicated interactive surface for concrete consequences.

A dedicated approval component should support:

* Scrolling.
* Grouping affected paths by reason.
* Clear explanations of irreversible loss, secret access, privilege escalation, or workspace escape.
* Representative paths with expandable complete lists.
* Recovery checkpoint details when available.
* Keyboard shortcuts for approve, reject, and inspect.
* Copying operation details.
* One-time approval only; no remembered command or directory trust.

This would make rare approvals precise and consequence-based.

## Code intelligence work

### 11. Improve retrieval ranking and presentation

Codesearch is functional, but earlier acceptance runs showed weak ranking and provider labels such as `block (11 lines)` in result presentation.

Further improvements:

* Prefer exact declarations over references.
* Separate source definitions, references, tests, docs, and generated files.
* Render snippets rather than opaque provider labels.
* Make paths selectable and openable.
* Explain semantic versus lexical contribution.
* Avoid retrieval churn during passive status reconstruction.
* Add query-quality benchmarks using actual Atelier planning tasks.

### 12. Make multi-repository execution usable, not merely correct

Multi-repository snapshot and freshness correctness is implemented, but the UX remains limited.

Correction:

* Show repository ownership for every approved path.
* Make the session workspace boundary explicit for each repository.
* Require explicit workspace expansion rather than silently treating VCS roots as trusted.
* Coordinate one task transaction across multiple local changes.
* Show which repository blocked resume.
* Provide per-repository validation and diff review.
* Support partial failure and recovery without losing evidence.

## Product UX work

### 13. Build the missing IDE-facing surfaces

The project still does not implement:

* `Ctrl-P` file palette.
* `Ctrl-B` project tree.
* Yazi navigation.
* skim/fzf selection.
* Clickable source references.
* Helix-native opening.
* Dedicated diff review.

These should begin only after the remaining safety work, but they are what will make Atelier feel like an ADE rather than a Pi workflow extension.

A practical order:

1. Clickable code-search paths.
2. Helix open-at-line.
3. Dedicated diff review.
4. File palette.
5. Project tree.
6. Multi-repository navigator.

### 14. Reduce plan-format friction

The machine-readable `execution` object is necessary for exact task authority, but manually writing embedded JSON in Markdown is poor UX.

Correction:

* Generate execution metadata from a guided editor.
* Add `atlr plan scope`.
* Validate paths interactively.
* Offer completion for configured validations.
* Format metadata canonically.
* Show a readable authorization section in Markdown while retaining machine-readable data.
* Prevent the model from producing invalid or overly broad scope silently.
* Keep task authority separate from the workspace recoverability policy: the plan defines what the task should change, while the workspace policy determines whether each concrete operation is recoverable.

## Architectural work

### 15. Eliminate compaction dependence

Atelier reconstructs Working State during `session_before_compact`, but Pi still compacts the conversation.

Correction:

* Keep the session transcript disposable.
* Start every agent turn from authoritative Working State plus a bounded recent tail.
* Disable or bypass Pi compaction where its API permits.
* Verify that restart and long-session behavior are equivalent.
* Add tests with intentionally corrupted or irrelevant conversation history.

### 16. Split the local core from the Pi process

Each Pi session currently opens its own Core instance and providers. Longer term, a small local Atelier service would improve:

* Concurrent sessions.
* Provider process reuse.
* Index coordination.
* Ledger serialization.
* Editor integrations.
* Non-Pi clients.
* Crash recovery.

This should come after the subprocess, workspace-policy, and host-isolation work, not before.

## Recommended order

### Alpha.10 — workspace recoverability and host isolation

1. Replace the current trust and granular permission model with the session workspace-boundary and recoverability policy described in section 1.
2. Remove `/atelier-trust`, persisted Atelier trust state, remembered blanket approvals, and obsolete permission profiles.
3. Add effect analysis, canonical workspace guarding, VCS recoverability classification, and automatic checkpoints.
4. Route structured tools, Pi `tool_call`, Bash, and `user_bash` through the new evaluator.
5. Introduce minimal subprocess environments.
6. Add secret-path approval, secret redaction, and retention controls.
7. Add Beads v2 JSON-envelope compatibility.
8. Convert Git, Jujutsu, and Beads operations used by the TUI to asynchronous, cancellable subprocesses.
9. Consolidate CLI, Pi, footer, and Working State presentation around a shared status model.

### Alpha.11 — runtime containment and recovery

* Add macOS and Linux runtime sandbox backends.
* Improve canceled-task recovery and task resumption.
* Add a dedicated consequence-based approval UI.
* Add provider process supervision.
* Expand automatic checkpoint recovery and inspection tooling.

### Alpha.12 — ADE interaction

* Clickable paths.
* Helix integration.
* Dedicated diff UI.
* Palette and tree.
* Multi-repository navigator.

The workspace-boundary and recoverability policy, minimal host environment, and durable checkpointing are the highest-priority changes before broader daily use.
