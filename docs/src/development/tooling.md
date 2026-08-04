# Tooling

This page is the exact reference for the contributor toolchain. Start with
[Setup](setup.md) before using these tasks.

## Repository files

| File                             | Purpose                                                   |
|----------------------------------|-----------------------------------------------------------|
| `mise.toml`                      | Declares pinned tools, environment, and named tasks.      |
| `mise.lock`                      | Records resolved tool downloads.                          |
| `hk.pkl`                         | Defines check, fix, and pre-commit steps.                 |
| `.config/rumdl.toml`             | Configures Markdown linting.                              |
| `contextlint.config.json`        | Configures documentation link and anchor checks.          |
| `cog.toml`                       | Configures Conventional Commits and changelog generation. |
| `scripts/setup-tooling.py`       | Installs the lockfile tools and repository hooks.         |
| `.github/workflows/validate.yml` | Runs locked validation on pushes and pull requests.       |
| `.github/workflows/docs.yml`     | Builds gated documentation.                               |

## Core tasks

| Task                              | Purpose                                          |
|-----------------------------------|--------------------------------------------------|
| `mise run check`                  | Run the complete repository quality contract.    |
| `mise run fix`                    | Apply deterministic hook fixes.                  |
| `mise run docs:check`             | Build and validate the documentation.            |
| `mise run docs:build`             | Build the mdBook site.                           |
| `mise run docs:serve`             | Serve the book locally, on port 3000 by default. |
| `mise run install_wrapper`        | Install the `atlr` wrapper in `/usr/local/bin`.  |
| `mise run docs:deployment:enable` | Enable workflow-built GitHub Pages through `gh`. |
| `mise run typecheck`              | Run TypeScript static analysis.                  |
| `mise run test`                   | Run the test suite.                              |

## Validation policy

The committed lock targets Linux and macOS x64 and ARM64. Windows is not part
of the POSIX-shell task contract. The mise environment routes hooks through
mise with `HK_MISE=1` and keeps Git fast-forward-only.

The hook suite checks byte order, executable shebangs, links, context, tables,
Markdown style, merge conflicts, secrets, typos, and whitespace. Commit-message
hooks enforce Conventional Commits and the repository's Beads footer format.

## Template and deployment administration

`.copier-answers.yml` records the dstack template channel and resolved commit.
Use `/update-project --stable` or `/update-project --unstable` for template
updates.

GitHub Pages requires `gh` authentication and both the workflow build type and
`DOCS_DEPLOYMENT_ENABLED=true`. Follow [GitHub Pages Deployment](github-pages.md)
for the administrative procedure.
