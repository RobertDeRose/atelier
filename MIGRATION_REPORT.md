# Atelier v0.8.8 Migration Report

No configuration migration is required.

Focused `auto` and `hybrid` source/test searches now perform bounded literal augmentation in
addition to semantic retrieval. JSON results may therefore contain:

```json
{
  "retrievalMethods": ["semantic", "lexical"],
  "providerRank": 8,
  "rank": 1,
  "provenance": {
    "actualMode": "hybrid",
    "postProcessing": [
      "fused semantic results with bounded literal identifier augmentation"
    ]
  }
}
```

Explicit `--mode semantic`, explicit `--mode lexical`, `--focus docs`, and `--focus all`
retain their previous behavior.

Run after updating:

```bash
mise install
mise run install
mise run check
mise run collect:codesearch
```
