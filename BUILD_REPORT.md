# Atelier v0.8.9 Build Report

## Validation

- Strict TypeScript check: passed
- Automated tests: 51 passed, 0 failed
- CLI smoke test: passed
- Line coverage: 83.28%
- Branch coverage: 67.37%
- Function coverage: 81.60%
- Eighth real-provider archive: normalized and committed as the pre-hint fusion fixture

## Main correction

The v0.8.8 live run raised codesearch mean weighted recall to 0.8571 and returned eight
semantic-plus-lexical fused results. It also showed that generic lexical candidates introduced
unrelated source paths and that test-focused ranking could exclude the companion implementation.
Atelier now augments healthy semantic retrieval only with exact identifier hints or code-shaped
query tokens and balances mixed source/test evidence.

## Environment note

The project remains pinned to Node 24.18.0, Aube 1.29.1, and codesearch 1.1.30 through mise.
The packaging environment used Node 22.16.0, the available TypeScript compiler, and the
committed Node declarations; the pinned mise/Aube workflow remains authoritative.
