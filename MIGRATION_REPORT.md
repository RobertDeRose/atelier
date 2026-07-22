# Atelier v0.8.7 Migration Report

No configuration migration is required.

`atlr code search` accepts a new optional focus:

```bash
atlr code search --focus source "where is provider selection implemented?"
atlr code search --focus tests "which tests verify normalization?"
atlr code search --focus docs "why was codesearch selected?"
```

The default remains `--focus auto`. Neutral queries preserve provider order. Focused
queries may return different top results because the final limit is now applied after
bounded overfetch, workflow path preference, and path diversification. Original provider
rank remains available as `providerRank` in JSON output.

Run after updating:

```bash
mise install
mise run install
mise run check
mise run collect:codesearch
```
