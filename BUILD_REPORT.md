# Build report

Atelier v0.10.0 completes the first task-backed repository retrieval vertical slice.

The release persists planning objectives, retrieves code evidence in plan mode before a task exists,
filters ready work to the approved plan, records deterministic task-selection rationale, and
reconstructs dependencies, blockers, corrections, findings, Manual Edits, and validation evidence in
Working State. Retrieval queries preserve focus, literal hints, result counts, degradation, warnings,
and normalized provider provenance.

Validation:

- strict TypeScript check: passed
- automated tests: 74 passed, 0 failed
- CLI smoke test: passed
- line coverage: 86.55%
- branch coverage: 66.85%
- function coverage: 85.73%
- approved-plan task filtering and provider-outage persistence regressions: passed
- planning-mode repository retrieval regression: passed
