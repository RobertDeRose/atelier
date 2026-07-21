# Codesearch Evaluation Report — 2026-07-21

## Scope

This report records the first live comparative retrieval run against Atelier commit
`4cb5346c135d53c93e65e7e31e375f7924258147` using codesearch 1.1.30 in self-contained
stdio mode.

The run compared two retrieval paths over the same repository and task set:

1. Baseline ripgrep retrieval.
2. Codesearch retrieval through Atelier's provider contract.

This measures repository discovery, not final agent implementation correctness.

## Provider conformance

The supplied live probe passed all 23 required checks with no warnings or failures. It
confirmed:

- MCP initialization and tool discovery.
- A ready local index.
- Semantic search and symbol lookup.
- Fetch-on-demand through `get_chunk`.
- File outlines through `explore`.
- `find_impact` availability, although no language-specific SCIP indexer was installed.
- Working-copy edit, reindex, and follow-up search behavior.

The provider contract is therefore sufficiently verified for continued evaluation. The
remaining uncertainty is retrieval quality and routing policy, not basic process or MCP
compatibility.

## Results

| Task | Baseline expected paths | Codesearch expected paths | Baseline time | Codesearch time |
|---|---:|---:|---:|---:|
| Locate provider selection | 2 / 2 | 0 / 2 | 30 ms | 407 ms |
| Trace the code-search command | 2 / 2 | 0 / 2 | 27 ms | 412 ms |
| Find normalization tests | 2 / 2 | 2 / 2 | 26 ms | 394 ms |
| Find Working State evidence integration | 1 / 2 | 1 / 2 | 25 ms | 401 ms |
| **Total** | **7 / 8** | **3 / 8** | **108 ms** | **1,614 ms** |

Total serialized output was similar: 49,407 bytes for the baseline and 50,638 bytes for
codesearch.

## Returned-path observations

The failed exact-path checks were not caused by absolute-path comparison. The captured
results showed that codesearch genuinely ranked different files:

- Provider-selection retrieval favored the MCP probe, ADRs, code-intelligence
  documentation, and `code/service.ts`; it did not return `core.ts` or `registry.ts`.
- Command tracing favored the MCP probe, `codesearch-provider.ts`, its tests, and ADRs; it
  did not return the CLI dispatcher or `code/service.ts`.
- Normalization-test retrieval correctly returned both the provider implementation and
  its test.
- Working State retrieval returned `working-state-builder.ts` but favored architecture and
  implementation-plan documents over `core.ts`.

This suggests that semantic retrieval is currently biased toward highly descriptive
project documentation and provider-specific implementation text. That may be useful for
architectural explanation, but it underperforms literal retrieval for these exact source
location tasks.

## Timing interpretation

The archived collection run recorded steady-state queries between 394 and 412 ms. A
separate first run observed a roughly 24.7-second first query, consistent with process,
model, or index warm-up. Atelier v0.8.1 records that first call separately as `coldStart`
so it no longer contaminates steady-state task timings.

## Evaluation corrections in v0.8.1

The original benchmark treated every expected file as equally important and reported only
exact presence. The updated runner now records:

- Repository-relative returned paths.
- Every ranked path in the summary.
- Weighted expected results with rationale.
- Weighted recall.
- Reciprocal rank.
- nDCG@10.
- A separate cold-start measurement.
- Aggregate baseline and codesearch metrics.

The revised prompts are phrased as realistic agent questions and include secondary
relevant files rather than only one rigid answer set.

## Current conclusion

Codesearch 1.1.30 is operationally suitable as an Atelier Code provider, but this initial
small-repository benchmark does not yet justify routing all code-location tasks to semantic
search by default.

The evidence currently supports a mixed policy:

- Use literal search or direct tools for exact identifiers and known implementation terms.
- Use semantic search for unfamiliar concepts, cross-file workflows, and unknown paths.
- Verify critical semantic results with source reads.
- Consider path or document-type scoping when the task explicitly asks for implementation
  code rather than architecture documentation.

A second live run with the v0.8.1 weighted benchmark is required before deciding whether
Atelier should change its default query routing or proceed to an Octocode comparison.
