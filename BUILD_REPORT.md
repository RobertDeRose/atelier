# Build report

Atelier v0.9.8 completes the second-provider decision gate.

The retained machine-side comparison passed 33 conformance checks, recorded one retrieval-quality warning, and had no required failures. Baseline and codesearch both reached 1.0 mean weighted recall; codesearch reached 1.0 MRR and 0.9082 nDCG@10. Octocode reached 0.2009 weighted recall, 0.375 MRR, and 0.2323 nDCG@10.

Validation:

- strict TypeScript check: passed
- automated tests: 69 passed, 0 failed
- CLI smoke test: passed
- line coverage: 85.39%
- branch coverage: 65.93%
- function coverage: 84.74%
- portable Octocode comparison fixture: passed
