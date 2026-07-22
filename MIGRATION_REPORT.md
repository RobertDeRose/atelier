# Atelier v0.8.9 Migration Report

No configuration migration is required.

Automatic and hybrid searches may now receive exact identifier hints:

```bash
atlr code search \
  --hint createCodeProvider,CodeProviderRegistry,codeProvider \
  "How does Atelier choose the configured code provider?"
```

Healthy semantic retrieval no longer derives literal augmentation from generic workflow nouns.
Broad term extraction remains available only for degraded fallback when the semantic provider
fails. Questions that explicitly request both implementation and tests resolve to an internal
mixed focus and interleave source and test evidence inside the final result budget.

Run after updating:

```bash
mise install
mise run install
mise run check
mise run collect:codesearch
```
