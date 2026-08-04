# Legacy Decision Record 0022 — Coordinate background code indexing

Status: accepted

## Context

Pi previously opened codesearch MCP during normal provider use while `/code-index`
could independently start the codesearch CLI writer. A live planning session showed
that the second writer failed with Tantivy `LockBusy`. Index state was also absent
from the interactive footer, and searches could race an index request.

## Decision

`CodeService` owns one in-flight indexing promise per Atelier core:

- Pi requests indexing without blocking session startup.
- Concurrent startup and `/code-index` calls join the same operation.
- Search, symbol, and relationship requests await an active operation.
- Status reads return coordinator state without touching MCP while indexing.
- The coordinator publishes building, ready, and failed transitions.
- Pi renders those transitions in its existing footer status.
- Provider-specific writer shutdown, indexing, verification, and MCP reconnection
  remain inside `CodesearchProvider`.

The coordinator records requested, completed, and failed lifecycle events in the
ledger. It does not hide failures: background failures are displayed in Pi and
explicit `/code-index` callers receive the original error.

## Consequences

There is one writer lifecycle within a running Atelier core. Multi-process
coordination remains the provider's responsibility; Atelier does not introduce a
second lock file or indexing database.
