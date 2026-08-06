# Contracts

This section collects exact commands, formats, configuration, and stable
contracts. Explanatory architecture belongs in [Architecture](../architecture/overview.md);
end-user procedures belong in the [User Guide](../user-guide/index.md); contributor
commands belong in [Development](../development/setup.md).

## Plan and workflow contracts

The canonical plan format is documented with the delivered
[Exact Plan Execution](../features/exact-plan-execution/index.md) feature.

## Context capsule contract

Core can build a bounded `ContextCapsule` for a task or feature through
`AtelierCore.buildContextCapsule()`. The caller supplies exact repository-relative
document paths and any already-inventoried quality gates; Core does not scrape
arbitrary files. Each section records its authority, exact location or boundary,
source digest, freshness, item count, byte count, omissions, and truncation state.

The capsule also contains a stable boundary digest, a stable content digest, a
redacted machine-readable value, and a compact Markdown rendering. Default limits
are 64,000 section bytes, 64,000 rendered-output bytes, 32 ordinary items, 20 history
entries, and 8 retrieval entries;
callers may provide lower positive limits. A capsule is reusable only when the task,
source snapshot identity, provider/retrieval state, documents, gates, and execution
boundary have the same digest. Changed source boundaries therefore fail closed to a
new capsule rather than reusing stale evidence. `ContextCapsuleCache` provides the
same-boundary reuse primitive without depending on Pi or terminal APIs.

## Implementation contracts

The current code and tests remain the authority for implementation details that
are not yet documented as a supported contract. Provider-specific contracts and
retrieval limits are documented with the
[Code Intelligence and Retrieval](../features/canonical-retrieval-planning/code-intelligence/index.md)
feature documentation.
