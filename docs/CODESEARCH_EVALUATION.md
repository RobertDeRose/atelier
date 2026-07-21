# Codesearch Evaluation and Conformance

## Status

Atelier v0.8.0 turns the codesearch proof of concept into a repeatable conformance and comparative evaluation workflow.

## Portable fixtures

Run `mise run fixtures:codesearch` after a live probe to normalize timestamps, home directories, repository roots, and database paths. The normalized fixtures can be committed without exposing machine-specific paths and are used for adapter regression tests.

## Comparative evaluation

`mise run evaluate:code` executes every task twice:

1. Baseline retrieval through ripgrep.
2. Codesearch retrieval through Atelier's provider contract.

The report records duration, result count, unique paths, bytes retrieved, expected paths found, and expected paths missed. It writes `.atelier/evaluation/latest.json` plus a timestamped immutable report.

This is a retrieval comparison, not yet a full autonomous-agent correctness benchmark. A later stage can execute identical implementation tasks with fixed model/tool budgets and human scoring.

## Machine-side knowledge collection

Run:

```bash
mise run collect:codesearch
```

The script runs the complete live probe, captures MCP initialization and schemas, waits for the index, exercises search, definition lookup, fetch-on-demand, outline, optional impact analysis, edit/reindex behavior, and the comparative evaluation. It then creates normalized portable fixtures beneath the probe output.

Archive the result with the command printed by the script and attach it to the next development session.
