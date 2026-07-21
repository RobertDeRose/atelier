# Codesearch Evaluation and Conformance

## Status

Atelier v0.8.4 provides a repeatable live conformance workflow and a ranked comparative
retrieval benchmark for codesearch.

The first evidence report is in
`docs/CODESEARCH_EVALUATION_REPORT_2026-07-21.md`.

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

Automatic mode first requests semantic retrieval. Provider operational failures are not treated as empty search results: Atelier retries through a bounded set of literal queries, records degraded provenance, and retains the original semantic error. Explicit semantic-mode probes remain separate so the benchmark cannot misrepresent literal fallback as healthy vector retrieval.

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

It writes `.atelier/evaluation/latest.json` plus a timestamped immutable report.

This is a retrieval comparison, not yet a full autonomous-agent correctness benchmark. A
later stage can execute identical implementation tasks with fixed model and tool budgets
and human scoring.

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
