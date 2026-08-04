# Setup

This page is for contributors and maintainers. End users should start with the
[Quickstart](../getting-started/quick-start.md) instead.

## Clone the workspace

```sh
git clone https://github.com/RobertDeRose/atelier.git
cd atelier
```

Atelier is developed with Node.js 24.18.0 and the repository's pinned mise
toolchain. The locked toolchain provides Aube, Jujutsu, Beads, codesearch,
Octocode, mdBook, documentation linters, and repository hooks.

## Install the required tools

```sh
mise install --locked
mise run init
```

`mise run init` installs the frozen JavaScript dependencies, prepares the
optional Octocode development environment, and builds the project. Provider
binaries are useful for live integration work but are not required by the
fixture-based unit suite.

## Build and run locally

```sh
npm run build
mise run atlr -- --help
mise run launch /path/to/your/project
```

Development-only source execution is available with:

```sh
npm run atlr:dev -- --help
npm run launch:dev
```

## Validate changes

Use the same checks locally and in CI:

```sh
mise run typecheck
mise run test
mise run docs:check
mise run check
```

`mise run check` is the complete repository contract. `mise run fix` applies
safe deterministic formatting and hook fixes; inspect its diff before staging.

## Documentation and release tooling

Build or serve the book while editing documentation:

```sh
mise run docs:build
mise run docs:serve
```

GitHub Pages deployment is a repository-maintainer operation. Follow
[GitHub Pages Deployment](github-pages.md) only when deployment is explicitly
needed.

The hook suite checks byte order, executable shebangs, links, context, tables,
Markdown style, merge conflicts, secrets, typos, and whitespace. Commit-message
hooks enforce Conventional Commits and the repository's Beads footer format.
