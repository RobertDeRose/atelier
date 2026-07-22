# Atelier v0.9.0 Migration Report

No migration is required for existing codesearch users. Codesearch remains the default.

New optional configuration:

```json
{
  "codeProvider": "octocode",
  "octocodeCommand": "octocode"
}
```

Run `mise run collect:octocode` after installing and configuring Muvon Octocode.
