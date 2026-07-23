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

The development bootstrap pins Octocode 0.14.0 through mise. Octocode may still require an embedding-provider configuration depending on the platform build. The collector preserves all stdout, stderr, exit statuses, MCP tool schemas, and an attachable `atelier-octocode-knowledge.tar.xz` archive.
