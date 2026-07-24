# Octocode experimental provider

Atelier includes an experimental adapter for Muvon Octocode. It launches one local MCP process per repository, allowing an Atelier multi-repository workspace to remain provider-neutral even though each Octocode MCP process is rooted at one project.

Verified public entry points used by the adapter:

```text
octocode index
octocode mcp --path <repository>
```

The adapter discovers MCP schemas at runtime. With Atelier's project-local FastEmbed and non-LLM GraphRAG configuration, Octocode 0.14.0 advertised `semantic_search`, `view_signatures`, `structural_search`, and `graphrag`. Atelier enables only the capabilities advertised by each repository process.

Configure Octocode as the default provider in `.atelier/config.json`:

```json
{
  "codeProvider": "octocode",
  "octocodeCommand": "octocode"
}
```

Or select it explicitly:

```bash
atlr code search "where is authentication handled?" --provider octocode
atlr code symbols "OctocodeProvider" --provider octocode
# `code related` becomes available only when the MCP server advertises `graphrag`.
```

Run the machine-side probe with:

```bash
mise run collect:octocode
```

The development bootstrap pins Octocode 0.14.0 through mise and writes `.atelier/octocode-config.toml` with local FastEmbed code and text models. Atelier passes that file through `OCTOCODE_CONFIG_PATH`, checks the configured embedding model before indexing, and verifies that `octocode stats` reports at least one searchable code, text, document, or commit block before accepting the index as ready.

An installation that intentionally uses cloud embeddings can configure them explicitly:

```bash
export VOYAGE_API_KEY="..."
octocode config \
  --code-embedding-model "voyage:voyage-code-3" \
  --text-embedding-model "voyage:voyage-3.5-lite"
```

Atelier does not rewrite the user-level Octocode configuration. The collector records model names and API-key presence booleans, never secret values, and preserves all stdout, stderr, exit statuses, MCP tool schemas, and an attachable `atelier-octocode-knowledge.tar.xz` archive. Octocode 0.14.0 returns its MCP evidence as formatted text; the adapter normalizes semantic result blocks, signature sections, and GraphRAG relationship lines into Atelier domain records.


## Development configuration

Atelier uses `OCTOCODE_CONFIG_PATH=.atelier/octocode-config.toml` and writes that managed file directly with local FastEmbed models during `mise run install`. This avoids the observed Octocode 0.14.0 `config` command path inconsistency, does not mutate the user-wide configuration, and requires no cloud embedding credentials. Existing unmanaged project-local configuration is preserved.

Octocode 0.14.0 indexing is invoked as `octocode index`; it does not support a `--force` argument. Atelier verifies block counts after the command and reports an actionable error if the existing index remains unusable.
