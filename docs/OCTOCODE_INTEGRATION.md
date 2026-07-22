# Octocode experimental provider

Atelier includes an experimental adapter for Muvon Octocode. It launches one local MCP process per repository, allowing an Atelier multi-repository workspace to remain provider-neutral even though each Octocode MCP process is rooted at one project.

Verified public entry points used by the adapter:

```text
octocode index
octocode mcp --path <repository>
```

The adapter discovers MCP schemas at runtime and maps the advertised `semantic_search`, `view_signatures`, `graphrag`, and `structural_search` tools onto Atelier capabilities. Only operations whose tools are actually advertised are enabled.

Configure Octocode as the default provider in `.atelier/config.json`:

```json
{
  "codeProvider": "octocode",
  "octocodeCommand": "octocode"
}
```

Or select it explicitly:

```bash
atlr code search --provider octocode "where is authentication handled?"
atlr code related --provider octocode --path src/auth.ts src/auth.ts
```

Run the machine-side probe with:

```bash
mise run collect:octocode
```

The development bootstrap pins Octocode 0.14.0 through mise. Octocode may still require an embedding-provider configuration depending on the platform build. The collector preserves all stdout, stderr, exit statuses, MCP tool schemas, and an attachable `atelier-octocode-knowledge.tar.xz` archive.
