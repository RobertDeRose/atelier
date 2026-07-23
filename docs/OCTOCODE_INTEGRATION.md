# Octocode experimental provider

Atelier includes an experimental adapter for Muvon Octocode. It launches one local MCP process per repository, allowing an Atelier multi-repository workspace to remain provider-neutral even though each Octocode MCP process is rooted at one project.

Verified public entry points used by the adapter:

```text
octocode index
octocode mcp --path <repository>
```

The adapter discovers MCP schemas at runtime. Octocode 0.14.0 on the tested macOS ARM installation advertised `semantic_search`, `view_signatures`, and `structural_search`; it did not advertise `graphrag`. Atelier therefore enables semantic retrieval and file-outline capabilities while keeping relationships capability-gated.

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

The development bootstrap pins Octocode 0.14.0 through mise. The release binary currently defaults to `voyage:voyage-code-3`, which requires `VOYAGE_API_KEY`. Atelier checks the configured code embedding model and refuses a long indexing run when its required key is absent. It also verifies that `octocode stats` reports at least one searchable code, text, document, or commit block before accepting the index as ready.

Example cloud setup:

```bash
export VOYAGE_API_KEY="..."
octocode config \
  --code-embedding-model "voyage:voyage-code-3" \
  --text-embedding-model "voyage:voyage-3.5-lite"
```

Local embedding models are supported only by Octocode builds compiled with the relevant feature. Atelier does not silently rewrite the user-level Octocode configuration. The collector records model names and API-key presence booleans, never secret values, and preserves all stdout, stderr, exit statuses, MCP tool schemas, and an attachable `atelier-octocode-knowledge.tar.xz` archive.


## Development configuration

Atelier uses `OCTOCODE_CONFIG_PATH=.atelier/octocode-config.toml` and creates that file with local FastEmbed models during `mise run install`. This avoids mutating the user-wide Octocode configuration or requiring cloud embedding credentials.
