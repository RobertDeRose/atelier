# Setup, launch, and configuration

This page explains how Atelier chooses a workspace, initializes project files,
selects external tools, and stores runtime state.

## Prerequisites

Install the pinned toolchain when using the repository checkout:

```sh
mise install --locked
mise run init
```

A working project normally needs Node.js 24 or newer, Git or Jujutsu, and Pi
for the interactive path. Beads is the default task provider. Codesearch is the
default code provider, but code intelligence can be disabled or replaced with
another configured provider.

If `atlr` is not installed as a wrapper, run it from the Atelier checkout with
`mise run atlr -- --help`, or install the wrapper described in the
[Quickstart](../getting-started/quick-start.md).

## Initialize and launch a workspace

From the project that Pi should work on:

```sh
cd /path/to/project
atlr launch
```

The first launch creates missing `.atelier/config.json`, `.atelier/PLAN.md`,
and `.atelier/validation.json`. Later launches reuse those files. Launching Pi
is not a trust operation and does not grant access outside the workspace.

Use an observational diagnostic before changing anything:

```sh
atlr doctor
atlr doctor --json
```

`doctor` checks the selected workspace, project files, Node, Git, Jujutsu, Pi,
Beads, and the resolved editor. It does not open the ledger, start providers,
or create project state. `Operational` means no issue was detected;
`Degraded` includes the actionable issues it found.

For a repository elsewhere in the current checkout, use the global `--root`
option. For sibling or nested repositories, give the process one common
workspace root:

```sh
atlr --root /path/to/project status
atlr --workspace /path/to/workspace --root /path/to/project launch
atlr --workspace ../workspace workspace status
```

The workspace is captured when the process starts and cannot silently expand
when a command changes directory. Every configured repository remains bound to
its own root and revision.

From the Atelier checkout, the mise launcher can initialize and open another
project without installing a wrapper:

```sh
mise run launch /path/to/project
mise run launch /path/to/project -- --no-session
```

The first argument is the workspace path; arguments after `--` are passed to
Pi. `atlr launch` accepts Pi arguments after the command as well.

To initialize Beads explicitly, use:

```sh
atlr init --beads
# Only when the provider supports it and quiet initialization is desired:
atlr init --beads --stealth
```

`atlr init` prints JSON describing the project paths and task-provider status.
It creates the plan document but does not approve or activate work.

## Project and runtime files

The following files are project data and may be committed when the project
chooses to share them:

| Path                       | Purpose                                                                    |
|----------------------------|----------------------------------------------------------------------------|
| `.atelier/config.json`     | repository-scoped declarative choices such as provider types and plan path |
| `.atelier/PLAN.md`         | the reviewed human-readable plan and task execution contracts              |
| `.atelier/validation.json` | closure policy and argument-array validation definitions                   |
| `.atelier/workspace.json`  | optional multi-repository identities                                       |

Mutable runtime data stays outside the repository. By default Atelier uses:

```text
${XDG_STATE_HOME:-~/.local/state}/atelier/repositories/<root-hash>/atelier.db
${XDG_STATE_HOME:-~/.local/state}/atelier/repositories/<root-hash>/code/codesearch-index-state.json
${XDG_STATE_HOME:-~/.local/state}/atelier/repositories/<root-hash>/checkpoints/<checkpoint-id>/
```

Set `ATLR_STATE_HOME` to choose a different state home, or set
`XDG_STATE_HOME` for the usual platform-wide state location. A user config can
also set an external `runtimeDirectory` or `databasePath`; runtime paths must
remain outside the project. `ATLR_USER_CONFIG` selects a different user config
file from the default `~/.config/atelier/config.json`.

Do not commit `atelier.db`, provider indexes, or checkpoints. They contain
user-owned runtime and evidence state, not project configuration. Use
`atlr data inspect`, `atlr data export`, and `atlr data prune` to manage retained
redacted evidence rather than deleting the runtime directory while a session is
active.

## Global and project configuration

Atelier reads settings from two JSON files:

1. The user-wide file at `~/.config/atelier/config.json`.
2. The repository file at `.atelier/config.json`.

The global file is loaded first. The repository file then overrides matching
**declarative** settings, so shared defaults can be selected once while a
repository chooses its own provider type, retrieval budgets, security mode, or
plan path. `ATLR_USER_CONFIG=/path/to/config.json` selects a different global
file for an isolated environment or test.

For example, put shared defaults in the global file:

```json
{
  "codeProvider": "codesearch",
  "codeMode": "local",
  "securityMode": "enforced",
  "sandboxBackend": "auto"
}
```

Then a repository can opt into its local development behavior:

```json
{
  "codeProvider": "disabled",
  "securityMode": "core-only"
}
```

Executable selections (`editor`, `beadsCommand`, `jjCommand`, `codeCommand`,
and `octocodeCommand`) remain user-only. A repository cannot override them,
which prevents a cloned repository from selecting commands before its contents
are trusted. Runtime paths (`runtimeDirectory`, `databasePath`) also remain
user-controlled and outside the repository. If the global config supplies an
external `octocodeConfigPath`, that user-owned path remains authoritative;
otherwise the repository may use its project-local Octocode config path.

`securityMode: "core-only"` disables workspace permission enforcement and forces
`sandboxBackend` to `none`; it is intended only for trusted development. Use
`securityMode: "enforced"` for normal safety controls. Run `atlr config validate
--json` or `atlr doctor` to inspect the effective configuration.

## Configure an editor

Atelier resolves an editor in this order:

1. `ATLR_EDITOR` for the current process;
2. the `editor` field in the user Atelier config;
3. Pi's `externalEditor` setting where that Pi project setting is trusted,
   followed by the user Pi setting;
4. `VISUAL`;
5. `EDITOR`;
6. `nano` on non-Windows systems as the fallback.

Use `ATLR_EDITOR` for a one-off deterministic choice. It may include arguments:

```sh
ATLR_EDITOR='hx' atlr review
ATLR_EDITOR='code --wait' atlr review
```

For a persistent user choice, put executable selection in the user-owned
configuration, not the repository file:

```json
{
  "editor": "hx"
}
```

The default path is `~/.config/atelier/config.json`. The same file is the
appropriate place for user-owned executable overrides such as `beadsCommand`,
`jjCommand`, `codeCommand`, and `octocodeCommand`. Repository configuration is
not allowed to select those executables.

Pi also supports an external editor setting in its normal settings files:

```json
{
  "externalEditor": "hx"
}
```

Use the user setting at `~/.pi/agent/settings.json`. A project setting at
`.pi/settings.json` is considered only when the calling Pi flow has trusted
that project resource. If the CLI or Pi selects an unexpected editor, run
`atlr doctor` and inspect its editor line, then use `ATLR_EDITOR` to remove
ambiguity. An editor must be a foreground command; GUI editors generally need
a wait flag such as `code --wait` so review does not finish immediately.

When a TUI editor handoff fails, run `atlr review` in a normal terminal. Pi
stops the TUI before launching the editor and restarts it afterward; a
non-interactive Pi session reports an actionable terminal fallback instead of
trying to invoke a shell-based editor.

## Select providers

Project configuration selects provider *types*; user configuration selects
provider executables. The supported choices are:

| Setting                  | Choices                                      | Default      | Use                                       |
|--------------------------|----------------------------------------------|--------------|-------------------------------------------|
| `repositoryProvider`     | `auto`, `jj`, `git`                          | `auto`       | repository identity and local changes     |
| `taskProvider`           | `beads`, `memory`, `none`                    | `beads`      | ready work, task ownership, and closure   |
| `codeProvider`           | `disabled`, `mock`, `codesearch`, `octocode` | `codesearch` | indexing and code retrieval               |
| `codeMode`               | `auto`, `local`, `client`                    | `auto`       | provider execution mode                   |
| `providerFirstRetrieval` | `advisory`, `off`                            | `advisory`   | retrieval guidance before broad discovery |
| `securityMode`           | `core-only`, `enforced`                      | `enforced`   | workspace and shell safety mode           |
| `sandboxBackend`         | `auto`, `seatbelt`, `bubblewrap`, `none`     | `auto`       | available shell confinement               |
| `footer`                 | `atelier`, `status-only`, `disabled`         | `atelier`    | Pi footer ownership                       |

For example, a repository can declare:

```json
{
  "repositoryProvider": "auto",
  "taskProvider": "beads",
  "codeProvider": "codesearch",
  "providerFirstRetrieval": "advisory",
  "securityMode": "enforced",
  "sandboxBackend": "auto"
}
```

Use `atlr config validate --json` after editing configuration. Use
`atlr code providers --json` to see registered code providers,
`atlr code status` for health, and `atlr code index` to build or refresh the
selected index. External providers own their indexes; Atelier owns their
identity, scope, freshness, budgets, and durable evidence.

Codesearch is the normal local semantic provider. Octocode is optional and may
need its own installation and documented provider credentials in the process
environment. Do not put API keys in `.atelier/config.json`, plans, or evidence.
If no provider is needed, set `codeProvider` to `disabled`; direct typed reads
remain available and provider-first retrieval is advisory rather than a
security gate.

## Pi trust and workspace policy

Pi's `/trust` controls whether Pi loads project-local Pi resources. It is
independent of Atelier. Atelier evaluates every concrete filesystem effect for
workspace containment, likely secrets, privilege escalation, and exact recovery
through Git, Jujutsu, or a checkpoint.

When a supported Seatbelt or Bubblewrap backend is available, model shell work
uses it. With `sandboxBackend: "none"`, or when no backend is available, a
shell operation can require a concrete one-operation approval that states it
will run without OS-level confinement. Typed Atelier tools are preferred for
validation, commits, state, and closure.

## Multi-repository workspaces

Use `--workspace` when repositories are siblings or nested below a common
folder. Declare their identities in `.atelier/workspace.json`, then inspect the
binding before approval:

```sh
atlr --workspace ../workspace workspace status
atlr --workspace ../workspace status --json
```

Approval, source freshness, validation, diff review, and local finalization
bind each repository independently. A secondary repository changing outside
its approved baseline invalidates the transaction; a multi-repository commit
may stop after recording the repositories already finalized. Recover the
reported partial set explicitly rather than assuming an automatic rollback.
