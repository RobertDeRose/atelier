# Atelier v0.8.2 Migration Report

No configuration migration is required from v0.8.1.

The behavior of `mise run collect:codesearch` changed intentionally. Previously, a
nonzero live-probe result stopped the wrapper before fixture normalization and archive
creation. It now:

1. Runs the live probe and retains its exit status.
2. Normalizes every available probe artifact.
3. Creates `atelier-codesearch-knowledge.tar.xz` in the repository root.
4. Prints the archive path and conformance summary.
5. Returns the retained nonzero status after all evidence is packaged.

Therefore a failed task can still produce a complete knowledge archive. Inspect
`.atelier/codesearch-probe/CONFORMANCE.md` or attach the generated archive for analysis.
Missing optional language-specific impact indexers are warnings rather than provider
conformance failures.
