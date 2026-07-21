# Atelier v0.8.0 Build Report

## Implemented

- Revision-qualified codesearch provenance and explicit stale-evidence classification.
- Optional codesearch `find_impact` call-relationship mapping.
- Optional `explore` capability discovery.
- Fetch-on-demand and federated chunk-reference probe coverage.
- Portable real-provider fixture normalization.
- Baseline-versus-codesearch comparative evaluation.
- Expanded machine-side knowledge collection script.
- Real codesearch 1.1.30 regression fixture from the supplied probe archive.

## Validation

Run `mise run check` for the authoritative development gate and `mise run collect:codesearch` on a machine with the pinned codesearch executable for live conformance.
