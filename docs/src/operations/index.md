# Operator's Manual

Atelier is a local interactive control plane. The CLI and Pi extension share the
same Core state, while repositories, task providers, code providers, editors,
validation commands, and OS sandboxes retain their native responsibilities.

## Start and inspect a workspace

```sh
cd /path/to/repository
atlr doctor
atlr init
```

`atlr doctor` is observational. It does not open the ledger, start providers,
or create project state. `atlr init` establishes the project configuration and
external runtime state needed by the workflow.

## Validate locally

Use [Local acceptance](local-acceptance.md) for the deterministic gate,
interactive acceptance flow, workspace setup, diagnostics, recovery, and
cleanup expectations.

Use [GitHub Pages deployment](github-pages.md) only when documentation
deployment is explicitly enabled for the repository.

## Recover and troubleshoot

Atelier keeps runtime state outside repositories and asks before operations that
may escape the workspace, expose likely secrets, require privilege escalation,
or cannot be recovered exactly. Repository checkpoints preserve the VCS state
needed by the configured recovery policy. Validation, evidence, and workflow
state remain durable even when a provider or interactive process fails.

For implementation-era corrections and acceptance history, see the
[historical operations records](history/index.md). These pages document prior
findings and evidence; they do not override the current architecture or
workflow contracts.
