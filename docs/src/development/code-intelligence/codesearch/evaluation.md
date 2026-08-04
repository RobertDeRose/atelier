# Codesearch Evaluation and Conformance

## Status

Atelier provides a repeatable live conformance workflow, a ranked comparative retrieval benchmark, and a deterministic provider-independent self-hosting economy scenario.

The first evidence report is in [the evaluation report](evidence/evaluation-2026-07-21.md). The bounded self-hosting result and live-run diagnostics are in [the retrieval economy report](evidence/retrieval-economy-2026-07-27.md).

## Test isolation

The normal unit and integration suite never starts a real codesearch process. Tests inject
a disabled, mock, or process-compatible fake provider explicitly.

Live provider testing is separate:

```bash
mise run test:codesearch:live
```

`mise run test:codesearch` remains an alias for compatibility.

## Portable fixtures

Run `mise run fixtures:codesearch` after a live probe to normalize timestamps, home
directories, repository roots, database paths, MCP responses, and the evaluation report.
The normalized fixtures can be committed without exposing machine-specific paths.

The importer now fails with an actionable error when the probe contains no recognized
artifacts. Use `--allow-empty` only for an intentional empty-probe test.

## Comparative evaluation

`mise run evaluate:code` performs one codesearch warm-up call and then executes every task
through both retrieval paths:

1. Baseline retrieval through ripgrep.
2. Codesearch retrieval through Atelier's provider contract in automatic mode.

Automatic mode first requests semantic retrieval. Focused source and test searches augment that candidate set only with bounded exact identifier hints from the task or code-shaped query tokens, then fuse the two rankings before final path selection. Generic workflow nouns no longer drive healthy-search augmentation. Provider operational failures are not treated as empty search results: Atelier retries through a broader bounded set of literal queries, records degraded provenance, and retains the original semantic error. Explicit semantic-mode probes remain separate so the benchmark cannot misrepresent literal fallback as healthy vector retrieval.

The report records:

- Cold-start duration separately from evaluated queries.
- Duration, result count, unique paths, and bytes retrieved.
- All repository-relative ranked paths.
- Weighted expected results and their ranks.
- Weighted recall.
- Reciprocal rank.
- nDCG@10.
- Aggregate metrics for each retrieval method.
- Degraded-result counts and unique provider warnings.
- Results supported by both semantic and literal retrieval.
- Exact identifier hints supplied to provider retrieval.
- Agent/tool calls and actual provider dispatches.
- Exact cache hits and safe overlap reuse.
- Unique paths and duplicate evidence identities removed.
- Model-facing bytes returned and truncation.
- Repository or index invalidations.
- Requested repository scopes.

It writes `.atelier/evaluation/latest.json` plus a timestamped immutable report. When codesearch is included, the runner also loads `evaluation/fixtures/accepted-codesearch-recall.json`. It fails if weighted recall drops below an accepted task score or if any previously accepted expected path disappears. Baseline, codesearch, and Octocode continue through the same scoring contract; tasks absent from the accepted fixture are reported without weakening that gate.

This is a retrieval comparison, not a claim about general autonomous-agent quality.

## Self-hosting economy acceptance

`evaluation/fixtures/self-hosting-retrieval-economy.json` records the observed planning baseline: 19 semantic searches, 20 symbol searches, 339 returned results, and 58 unique paths. It also lists the expected source, test, configuration, persistence, Pi, evaluation, and documentation evidence.

The provider-independent acceptance in `tests/self-hosting-retrieval-acceptance.test.ts` exercises the final sequence with a deterministic fake provider:

1. Build Working State from one semantic discovery.
2. Resolve only `UnresolvedInventorySymbol` after the inventory marks it unresolved.
3. Repeat an equivalent Unicode/whitespace-normalized query and require exact reuse.
4. Request a known path and require direct-read guidance.
5. Isolate two repository scopes.
6. Reopen the bounded ledger session without another provider call.
7. Change a repository revision and then the provider index revision.
8. Prove historical evidence is never labeled current after either invalidation.

The scenario permits at most eight repository-intelligence calls and eight provider calls. It additionally asserts unique model-facing paths, duplicate removal, provenance preservation, bytes, truncation state, and scope isolation. Ordinary tests inject the fake provider and do not require codesearch, Octocode, Jujutsu, or Pi.

For the live acceptance, use `mise run launch` in a clean or disposable Jujutsu-first workspace. Start with one focused semantic query, inspect its included inventory, read returned paths directly, use symbol lookup only for unresolved identifiers, and finish without broad file-tree scans. Record the final telemetry and require no more than eight repository-intelligence calls.

## Troubleshooting

- A failed accepted-recall gate names every lost path and lower weighted score.
- `index_revision` or `repository_revision` invalidations require a fresh provider result; cached provenance remains historical only.
- Empty fresh provider evidence may permit raw fallback in Pi. Cache hits and request-budget denial do not.
- A live codesearch MCP process may hold the local writer. Use Atelier's coordinated `code index` lifecycle rather than running competing indexers.
- Unknown provider index revisions disable current cache reuse by design.

## Workflow focus

Each evaluation task may declare `focus: source|tests|docs|all`; otherwise Atelier resolves
focus from the query. Questions explicitly requesting both implementation and tests resolve
to an internal mixed focus that interleaves both path classes. Both retrieval paths use the
same path-class preference so the comparison measures provider discovery rather than giving
only one side workflow context.

Codesearch results preserve two orders:

- `providerPaths` and `providerRank`: the provider's original compact candidate ranking.
- `paths` and `rank`: Atelier's focused, path-diverse final evidence order.

The provider adapter may request up to 50 compact candidates, while the final result and
Working State budgets remain unchanged. Reports record whether a task was reranked and how
many tasks used reranking.

## Machine-side knowledge collection

Run:

```bash
mise run collect:codesearch
```

The script runs the complete live probe, captures MCP initialization and schemas, waits
for the index, exercises semantic, hybrid, literal, and automatic search; definition lookup; fetch-on-demand; outline; optional
impact analysis; codesearch doctor/statistics; direct CLI search; index-store metadata, edit and reindex behavior, and the comparative evaluation. It then
creates normalized portable fixtures beneath the probe output and writes
`atelier-codesearch-knowledge.tar.xz` in the repository root.

Collection is evidence gathering, so post-processing continues even when provider
conformance fails. The archive and conformance report are retained, while the command
still exits nonzero after packaging so automation can detect the failure. Known missing
optional symbol indexers are warnings, including providers that set MCP `isError` while
returning the actionable installation message. Attach the generated archive to the next
development session.

## Vector-index repair gate

The live collection now records `codesearch stats` before and after `atlr code index`. Conformance requires a non-empty vector store with `Indexed: Yes`; MCP `ready` alone is insufficient. A transition from unbuilt to built is recorded as `vector_index_repaired`.

## v0.8.9 rerun requirement

The next authoritative benchmark must be collected with exact identifier hints and mixed
source/test focus enabled. The live conformance summary reports hint count, fused-result
count, implementation source rank, and weighted recall so the refinement can be evaluated
against the 0.8571 v0.8.8 result.
