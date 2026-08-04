# Legacy Decision Record 0006 — Release MCP Before Local Codesearch Indexing

## Status

Accepted.

## Date

2026-07-21

## Context

Atelier v0.8.4 correctly switched local repair from `codesearch index add` to the bare
`codesearch index <path>` command. The fourth real-provider collection showed that the
command still failed with Tantivy `LockBusy` while Atelier's own self-contained MCP
subprocess remained connected. The MCP server and CLI indexer were competing for the
same local FTS writer.

The same collection showed:

- MCP status reported ready;
- the vector store contained 1,006 chunks;
- HNSW remained unbuilt;
- local repair exited 1 with `Failed to acquire Lockfile: LockBusy`;
- semantic and hybrid retrieval remained unavailable;
- literal fallback continued to work.

## Decision

For local or auto-resolved-local operation, Atelier will:

1. Connect briefly to discover the provider routing mode and capabilities.
2. Close the MCP stdio process.
3. Wait for the child process to exit, using a bounded forced-termination fallback.
4. Run `codesearch index <repository-root>`.
5. Verify `codesearch stats <repository-root>` reports chunks and `Indexed: Yes`.
6. Restart MCP and wait for its status tool to report ready.

For serve-backed client mode, Atelier will continue using `codesearch index add` and
will not stop the local MCP client because the external service owns indexing and lock
coordination.

## Consequences

- Local repair no longer races an Atelier-owned MCP process for Tantivy's writer lock.
- Indexing introduces one intentional MCP restart.
- Provider shutdown becomes part of the correctness boundary and is covered by tests.
- A hung provider is terminated after a bounded graceful shutdown period.
- Literal fallback remains available for unrelated semantic failures but is not accepted
  as proof that local indexing succeeded.
