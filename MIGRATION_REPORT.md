# Atelier v0.8.0 Migration Report

No configuration migration is required from v0.7.1.

New development tasks:

```bash
mise run fixtures:codesearch
mise run collect:codesearch
mise run evaluate:code
```

Code evidence now includes freshness and indexed/current revision identities when Atelier has observed the indexing operation. Evidence returned after the working copy changes is marked `known_stale` until reindexing succeeds.
