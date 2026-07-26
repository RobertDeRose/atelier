# Build report

Atelier v0.10.6 adds a single background code-index coordinator shared by Pi startup, commands,
status, and retrieval.

The live demo session still used broad `find` and `rg` commands even though v0.10.4 had registered
provider tools and added provider-first routing. Pi maintains a separate active-tool list; a
registered extension tool is not guaranteed to be selected for the next model turn. The model
therefore continued to see generic repository tools as its practical discovery surface.

Atelier now explicitly activates the three read-only code tools whenever code intelligence is
enabled:

- `atlr_code_search`
- `atlr_code_symbols`
- `atlr_code_status`

The tools are ordered before the existing active tools so provider search is presented as the
primary discovery path. Activation converges on session start, `/plan` entry, and every agent turn,
which also covers resumed plan sessions and Pi active-tool changes between turns. Disabled code
providers do not force these tools into the active set.

The provider-first Bash gate remains independent of permission approval. Exact reads and proven
read-only shell commands execute without approval; broad raw discovery is blocked until provider
fallback is explicitly justified by unavailable, unhealthy, degraded, failed, or empty evidence.

Validation:

- strict TypeScript check: passed
- automated tests: 79 passed, 0 failed
- CLI smoke test: passed
- Pi active-tool activation regression: passed
- exact live `find` and `rg` discovery regressions: passed
- zero approval prompts for read-only plan commands: passed
- provider fallback after empty evidence: passed

Coverage:

- line coverage: 84.95%
- branch coverage: 67.35%
- function coverage: 84.38%
