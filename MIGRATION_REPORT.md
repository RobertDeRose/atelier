# Migration Report — v0.9.5

Octocode 0.14.0 does not accept `octocode index --force`. Atelier now uses the documented bare `octocode index` command for both direct collection and provider-managed indexing, then verifies that searchable blocks were produced.

`mise run install` now writes the managed `.atelier/octocode-config.toml` directly with local FastEmbed models and non-LLM GraphRAG. This avoids the observed Octocode `config` command behavior that wrote the user-wide configuration even when `OCTOCODE_CONFIG_PATH` was supplied. Existing project-local configurations without Atelier's management marker are preserved.
