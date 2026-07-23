# Migration report

## 0.9.2 to 0.9.3

No configuration migration is required. Octocode now refuses to spend time indexing when its configured cloud embedding API key is absent, and it verifies that an indexing run produced searchable blocks.

The live collector captures configuration and key-presence booleans without recording secret values.
