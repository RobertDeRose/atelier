# Migration report

## v0.9.1 to v0.9.2

No configuration migration is required.

The Octocode collector now invokes positional queries before boolean flags, captures direct MCP tool calls, and skips relationship collection when `graphrag` is not advertised. Generated Octocode indexes and probe archives are ignored. The first `octocode index` can run for many minutes; Atelier now permits a bounded 30-minute indexing operation while retaining shorter MCP query timeouts.
