# Atelier v0.7.1 Migration Report

## From v0.7.0

1. Run `mise install` to converge to the exact versions in `mise.toml` and `mise.lock`.
2. Run `mise run install`; the install now uses Aube's frozen-lockfile mode.
3. Remove previously generated tracked state from the working tree if it remains after applying the patch:

   ```bash
   git rm -r --cached --ignore-unmatch .atelier/atelier.db .atelier/codesearch-probe .atelier/evaluation .codesearch.db
   ```

4. Run `mise run check`. TypeScript now explicitly loads the Node declarations.
5. Run `mise run test:codesearch`. The probe waits for index readiness and writes a conformance report under `.atelier/codesearch-probe/`.

## Configuration

The new optional setting controls the total index-readiness wait:

```json
{
  "codeIndexTimeoutMs": 300000
}
```

The default is five minutes. `codeTimeoutMs` remains the timeout for an individual MCP request.

## Behavioral changes

- `atlr code index` does not report success until codesearch reports `ready`.
- Search, symbol, and relationship operations wait for a ready index before querying.
- Local self-contained MCP mode omits `project` and `group`; client mode uses configured project aliases or the `all` group.
- Probe and provider-generated state is no longer versioned.
