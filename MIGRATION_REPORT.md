# Migration Report — v0.9.6

Octocode 0.14.0 returns successful MCP search, signature, and GraphRAG results as formatted text rather than structured JSON. Earlier Atelier adapters preserved the raw calls but normalized them to empty result arrays.

Atelier now parses Octocode's `CODE RESULTS`, `SIGNATURES`, and relationship text formats into provider-neutral evidence. Symbol lookup uses signature detail with a zero similarity threshold, and the raw GraphRAG probe now sends the advertised `operation = "get-relationships"` field.

No configuration migration is required. Rerun `mise run collect:octocode` to verify that search and symbol results are now retained.
