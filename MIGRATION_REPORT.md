# Migration Report — v0.9.4

`mise run install` now creates a project-local Octocode configuration under `.atelier`. It selects local FastEmbed models and enables GraphRAG without LLM processing, so development and conformance do not require `VOYAGE_API_KEY`. Existing user-wide Octocode configuration is not modified. The first index run uses `--force` when the existing project database contains zero searchable blocks.
