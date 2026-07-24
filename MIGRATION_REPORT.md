# Migration Report — v0.9.7

No runtime configuration migration is required.

The code-intelligence evaluator now accepts `--providers` with a comma-separated list. Its previous default remains `codesearch`, and existing reports retain direct `codesearch` fields. New reports also include provider-keyed `providers`, `coldStarts`, and aggregate sections.

`mise run collect:octocode` now refreshes both codesearch and Octocode indexes and runs the comparative benchmark. The next collection may therefore take longer than the prior conformance-only run.
