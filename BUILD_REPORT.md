# Build report

Atelier v0.10.4 corrects plan-mode investigation and makes the accepted code provider available to the
agent itself.

A live session exposed two related gaps. A shell command made entirely of `find`, `wc`, `rg`, and
`head` requested approval because `2>/dev/null` was treated as a file write and compound commands were
classified as arbitrary execution. The agent also used broad `find` and `rg` discovery because code
intelligence existed only as user-facing slash commands.

Atelier now parses command chains and pipelines outside quotes, classifies each segment independently,
and grants the compound read-only status only when every segment is read-only. Safe `/dev/null` sinks
and descriptor duplication are ignored for mutation classification. File output redirection, mixed
read/write compounds, `find -delete`, file-output actions, and mutating `find -exec` remain gated.

Pi now registers bounded agent-callable code status, search, and symbol tools. Plan mode enforces
provider-first discovery and allows raw broad scanning only after unavailable, unhealthy, degraded,
failed, or empty provider evidence. The routing denial never opens an approval dialog.

Validation:

- strict TypeScript check: passed
- automated tests: 79 passed, 0 failed
- CLI smoke test: passed
- exact live-session compound classification regression: passed
- read-only chained Git command regression: passed
- mutating compound and `find` regression: passed
- provider-first Pi routing regression: passed
- zero approval prompts for plan-mode reads: passed

- line coverage: 84.77%
- branch coverage: 66.97%
- function coverage: 84.21%
