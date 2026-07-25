# Migration Report — v0.10.4

No database, configuration, task, or provider-index migration is required.

After updating, launch Atelier normally:

```bash
mise run launch
```

Behavior changes in plan mode:

- read-only shell pipelines and command chains no longer request approval;
- safe diagnostic output to `/dev/null` remains read-only;
- broad raw repository discovery is redirected to the agent-callable Atelier code tools first;
- raw `rg`, `grep`, `find`, `fd`, `tree`, and `ls` discovery becomes available after the provider
  reports unavailable, degraded, failed, or empty evidence;
- mutations remain independently permission-gated.

No existing `.atelier/atelier.db`, reviewed plan, or code-provider index should be removed.
