# Code intelligence

Atelier integrates external code providers before building or owning an index.
The Core contract normalizes provider identity, capabilities, workspace and
repository scope, revision bindings, budgets, evidence provenance, caching,
and invalidation. Providers retain ownership of indexing and retrieval.

## Provider guides

- [Codesearch](codesearch/index.md) is the default semantic provider.
- [Octocode](octocode/index.md) is an optional capability-gated structural
  provider.

## Current boundary

Provider-first retrieval is advisory rather than an authorization gate. Direct
reads and repository observations remain bounded by workspace policy. Evidence
is isolated by provider, workspace, repository, source revision, and provider
index revision. Failed or degraded provider calls never become current durable
evidence.

The detailed [provider contract and implementation guide](provider-contract.md)
is retained as the technical contract and implementation history for the current
provider-neutral design.
