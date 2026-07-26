# Migration Report — v0.11.0

The SQLite ledger migrates automatically from schema version 1 to version 2 to
store durable workflow runs and ManualEdit records. No manual database,
configuration, task-provider, provider-index, or plan migration is required.
Pi now starts indexing automatically, exposes lifecycle state in the footer, and
coalesces `/code-index` with the active background operation.

Restart `mise run launch` after applying the patch so Pi reloads the corrected
`/plan` handler.

After updating, restart the Atelier shell so Pi rebuilds its active-tool set:

```bash
mise run launch
```

Behavior changes:

- Atelier code status, search, and symbol tools are explicitly active when the configured code
  provider is enabled;
- the tools are prioritized in the model-facing active-tool order;
- `/plan` names those tools directly and requires provider-first repository discovery;
- exact reads and proven read-only shell commands remain approval-free;
- broad raw `rg`, `grep`, `find`, `fd`, `tree`, and `ls` discovery remains available only after a
  provider fallback condition.

Existing `.atelier/atelier.db`, `.atelier/PLAN.md`, `.codesearch.db`, and task-provider state should
not be removed.
