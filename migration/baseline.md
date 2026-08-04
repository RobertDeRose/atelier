# Legacy workflow baseline

Generated: `2026-08-04T03:38:29+00:00`

## Documentation

- Status: `passed`
- Command: `npm run check:metadata`
- Note: Explicit baseline documentation command.

## Tests

- Status: `passed`
- Command: `1 named partition(s)`
- Note: See validation_partitions for command ownership and evidence.

## Hk

- Status: `absent`
- Command: `pkl eval hk.pkl`
- Note: No pre-adoption hk.pkl exists.

## Resolution

- Write eligible: `true`
- Unresolved: none
- Resolution flags: documentation=supplied; tests=supplied
- Uncovered candidates: none
- Residual limitations: none

## Validation partitions

- `root-mise-test` (tests): status=`passed`; argv=`mise run test`; cwd=`.`; provenance=`mise.toml`
  - Return code: `0`; output truncated: `true`
  - stdout:

        > atelier-prototype@0.14.0-alpha.46 build
        > rm -rf dist && tsc -p tsconfig.build.json

        ✔ Given a reviewed plan, the supported local workflow remains exact, durable, and resumable (86300.997208ms)
        ✔ classifies common and compound read-only commands (1.665042ms)
        ✔ classifies task, repository, dependency, and file mutations (0.373125ms)
        ✔ unknown and mutating compound commands still require approval (2.904125ms)
        ✔ dedicated approval dialog keeps scope visible and supports narrow terminals (0.518167ms)
        ✔ async process runner captures bounded output and exit status (138.149375ms)
        ✔ async process runner distinguishes timeout and cancellation (2036.93175ms)
        ✔ async process runner force-kills a timed-out process group that ignores SIGTERM (2005.046875ms)
        ✔ async process runner completes after parent exit when a detached descendant holds stdio open (166.740959ms)
        ✔ authoritative context is deterministic and explicitly rejects transcript authority (0.780125ms)
        ✔ normalizes Beads v2 JSON envelopes while retaining legacy responses (1.783667ms)
        ✔ normalizes representative Beads JSON into Atelier task records (0.405375ms)
        ✔ initialization hardens an existing tracked .beads directory (444.290583ms)
        ✔ Beads initialization is idempotent and preserves existing provider files (621.837458ms)
        ✔ uses structured JSON commands without shell interpolation (2055.061667ms)
        ✔ status does not report tracked Beads metadata as an initialized database (1234.133542ms)
        ✔ fake Beads adapter satisfies the shared reconciliation conformance (1752.971291ms)
        ✔ cancelled approved tasks resume without a second provider claim when exact bindings remain current (8721.751166ms)
        ✔ Core observation and workspace authorization share canonical path identity through a repository alias (9574.250291ms)
        ✔ canonical query digest is deterministic across set and repository ordering (10.578ms)
        ✔ query text normalization is conservative (0.7415ms)
        ✔ every semantic key field isolates canonical queries (0.973958ms)
        ✔ relationship reference identity is operation-specific (0.138ms)
        ✔ requested limit does not change identity and only covered lower limits are reusable (0.174833ms)
        ✔ evidence identity is provider, workspace, repository, revision, and location qualified (0.259417ms)
        ✔ empty normalized text and invalid limits are rejected (0.268708ms)
        ✔ provider index revisions are optional and capability-gated (1.971834ms)
        ✔ CLI code JSON keeps decision, telemetry, provenance, scope, invalidation, and truncation stable (10149.00125ms)
        ✔ CLI code text output includes inventory, reuse decision, and remaining budgets (17194.933625ms)
        ✔ CLI review, exact approval, cancellation, and JSON workflow remain coordinated (33924.306166ms)
        ✔ Given an unchanged exact query, repeated retrieval reuses one provider call (185.301542ms)
        ✔ Given greater cached coverage, a smaller limit reuses it but a greater limit does not reuse lower coverage (193.249917ms)
        ✔ Given truncated or degraded evidence, repetition calls the provider again (175.6235ms)
        ✔ Given inventoried paths and symbols, direct-read and safe overlap decisions avoid provider calls (152.61675ms)
        ✔ Given provider, repository, or index drift, cached evidence is invalidated before a fresh provider call (731.343542ms)
        ✔ Given a provider error, the failed request is never cached (965.245625ms)
        ✔ Given an unsupported capability, Atelier rejects before consuming provider budget (1147.548ms)
        ✔ Given exhausted provider requests, retrieval fails without raw-scan fallback (1289.709708ms)
        ✔ Given a result limit, Atelier bounds the provider request and model-facing result (1074.879125ms)
        ✔ Given duplicate chunks and paths, unique path, entry, and byte budgets are deterministic (1093.954ms)
        ✔ Given fetch limits, chunk count and total bytes are session-scoped (965.687208ms)
        ✔ Complete fetched chunks reuse only while repository and index bindings remain current (461.023125ms)
        ✔ Symbols and relationships share request accounting and exact reuse (389.776ms)
        ✔ Multi-repository and workspace scopes never reuse or leak evidence (894.658834ms)
        ✔ code evaluation compares baseline, codesearch, and octocode through the same CLI contract (3416.053417ms)
        ✔ code presentation ranks exact definitions before references, tests, docs, and generated paths (0.983958ms)
        ✔ code search focus infers source, tests, mixed, docs, and neutral queries (1.227917ms)
        ✔ code path classification separates product source from tests, docs, and tooling (0.226166ms)
        ✔ focused path ranking preserves provider order within each path class (0.665042ms)
        ✔ code indexing coordinator coalesces requests and makes search wait for the active writer (11644.568125ms)
        ✔ code provider contract supports multi-repository normalized search with provenance (16210.974792ms)
        ✔ Working State consumes normalized provider evidence without owning an index (26491.381375ms)
        ✔ repeated Working State builds reuse one provider request at the same revisions (19283.09025ms)
        ✔ planning mode retrieves code from the durable objective before a task exists (27216.204084ms)
        ✔ file-scoped planning ignores the unreviewed plan scaffold and performs no semantic provider call (32067.588125ms)
        ✔ explicit symbol lookup normalizes provider signatures, ranks definitions first, and converges inventory (11698.781208ms)
        ✔ symbol resolution remains repository-scope qualified (6179.896833ms)
        ✔ symbol candidate extraction rejects plan expressions and generic product vocabulary (7072.266417ms)
        ✔ loads explicit multi-repository workspace configuration (19.492875ms)
        ✔ accepted codesearch evaluation matches baseline recall with better ranking (2.647791ms)
        ✔ codesearch collection preserves failed conformance evidence and still creates fixtures and an archive (2051.07ms)
        ✔ real codesearch fixture records a clean corpus but documentation-heavy ranking (10.628709ms)
        ✔ codesearch fixture import fails clearly when no probe artifacts exist (100.807375ms)
        ✔ codesearch fixture import normalizes the probed repository root (973.516459ms)
        ✔ real codesearch fixture records focused retrieval before lexical fusion (5.32475ms)
        ✔ real codesearch fixture records successful semantic and literal fusion before hint refinement (4.307792ms)
        ✔ codesearch excludes committed provider evidence from repository retrieval (1.474458ms)
        ✔ real codesearch fixture records the MCP writer lock that blocked local repair (4.569583ms)
        ✔ codesearch probe summary reports a ready conforming provider (4648.456041ms)
        ✔ codesearch probe summary treats unavailable optional impact indexing as a warning even when MCP sets isError (17251.103167ms)
        ✔ codesearch probe summary fails when ignored provider fixtures leak into results (6386.2ms)
        ✔ codesearch adapter negotiates MCP tools and normalizes search, fetch, and symbol results (2632.45175ms)
        ✔ codesearch canonicalizes workspace aliases and absolute provider result paths (1405.227333ms)
        ✔ codesearch index readiness outranks unrelated optional-index errors (3777.994ms)
        ✔ codesearch local indexing closes the MCP writer before running the CLI repair (2904.161084ms)
        ✔ codesearch client mode uses configured project aliases (1757.05925ms)
        ✔ codesearch auto search degrades to bounded literal retrieval when semantic storage fails (1373.490959ms)
        ✔ explicit semantic search surfaces provider operational errors (1135.548208ms)
        ✔ codesearch local indexing rejects an unbuilt vector index even when MCP reports ready (2028.436917ms)
        ✔ codesearch does not force a fresh index when MCP startup creates the database (2690.040917ms)
        ✔ codesearch repairs an existing empty database without forcing a rebuild (1111.41ms)
        ✔ codesearch forces an existing index when selection state is missing (2190.44875ms)
        ✔ codesearch index timeout reports the timeout and preserves partial output (1209.048ms)
        ✔ codesearch forces one local rebuild when repository selection inputs change (4385.111166ms)
        ✔ codesearch stores mutable selection state outside the repository and migrates legacy state (8396.033792ms)
        ✔ codesearch overfetches and reranks implementation searches toward diverse source paths (2550.665167ms)
        ✔ codesearch fuses bounded literal identifiers into focused automatic retrieval (1291.677167ms)
        ✔ codesearch augmentation uses explicit identifier hints instead of generic workflow nouns (1755.085084ms)
        ✔ codesearch does not augment healthy semantic search with generic natural-language terms (2121.967084ms)
        ✔ real codesearch 1.1.30 fixtures preserve the verified MCP contract (94.667875ms)
        ✔ real codesearch 1.1.30 fixture proves MCP ready can coexist with an unbuilt HNSW index (60.117875ms)
        ✔ real codesearch 1.1.30 fixture records vector-store failure without hiding literal capabilities (24.8485ms)
        ✔ real codesearch fixture records successful vector repair and semantic recovery (18.2335ms)
        ✔ plan review resumes across a Core restart (21272.930584ms)
        ✔ review, approval, reconciliation, and Working State form a runnable vertical slice (34339.206625ms)
        ✔ authorized tool attempts record observed success, failure, interruption, and bounded errors (26233.914292ms)
        ✔ closure diagnostics distinguish a missing focused selection from a missing validation configuration (34130.127917ms)
        ✔ focused validation gates closure, becomes stale after mutation, reruns, and survives restart (87405.393084ms)
        ✔ task closure requires current focused passes, invalidates execution, and exposes but does not start next task (29478.774458ms)
        ✔ exact approval rejection performs no provider mutation and creates no execution grant (15699.482167ms)
        ✔ approval rechecks and serializes against an execution grant that became active after preparation (22585.587958ms)
        ✔ successful exact approval reconciles, claims, then atomically enters act mode with a task grant (11558.83975ms)
        ✔ hash drift, provider drift, partial reconciliation, no ready task, and claim failure fail closed (79607.656458ms)
        ✔ provider preparation is separately confirmed and unavailable providers cannot prepare approval (7228.103084ms)
        ✔ cancellation revokes execution without altering task status (8013.856292ms)
        ✔ workspace approval decisions are concrete and never create remembered grants (5044.474292ms)
        ✔ restart preserves a valid grant and invalidates stale plan, provider, workspace, or task bindings (26588.74975ms)
        ✔ restart fails an applying transaction closed and a fresh confirmation recovers an already claimed task (5806.649458ms)
        ✔ later-task activation failure after claim fails closed and is recoverable without a second claim (7563.197083ms)
        ✔ starting a later task requires confirmation while reusing unchanged plan approval (6955.62175ms)
        ✔ starting an explicitly requested later task works after explicit closure revoked the prior grant (3243.706292ms)
        ✔ legacy execution records without an exact task constraint projection fail closed on resume (4072.583125ms)
        ✔ alpha.5 plans without structured execution contracts invalidate active execution on resume (1438.25625ms)
        ✔ Atelier footer uses two aligned lines without duplicated workflow or VCS state (1.261375ms)
        ✔ Atelier footer uses task titles when wide and Beads ids when narrow (0.552584ms)
        ✔ Atelier footer applies bold headings and semantic state colors (0.159375ms)
        ✔ Atelier footer keeps durable mode state separate from transient progress (0.12475ms)
        ✔ status-only and disabled footer modes release Pi footer ownership (0.477875ms)
        ✔ Atelier footer keeps thinking levels readable and treats disabled intelligence as neutral (0.198875ms)
        ✔ guided verification help renders without executing Markdown-style commands (235.41075ms)
        ✔ evidence archive setup prefers GNU tar when gtar is available (1017.015ms)
        ✔ guided verification resolves step workspace paths before launching and collecting evidence (45603.910291ms)
        ✔ guided verification auto-prepares missing workspaces and does not emit terminal-reset escapes before TUI launch (61245.880416ms)
        ✔ guided retry recreates only the failed workspace and preserves prior results (14695.158708ms)
        ✔ guided Git policy restores every path-scoped checkpoint and prints concrete evidence (9095.102875ms)
        ✔ live acceptance isolates unrelated user Pi extensions while loading Atelier explicitly (14.887458ms)
        ✔ live acceptance treats only correlated in-workspace EISDIR reads as benign (1379.203916ms)
        ✔ live acceptance verifies headless workspace denial from durable policy evidence (1.856375ms)
        ✔ guided acceptance verifies durable visual and model-Bash lifecycle evidence (11.808458ms)
        ✔ interactive status yields to the event loop and reuses one cached repository observation (26242.050459ms)
        ✔ interactive phase feedback is visible before delayed work starts (1.208458ms)
        ✔ agent lifecycle can force Pi's native working indicator while the context still reports idle (0.542291ms)
        ✔ explicit checkpoint approval is shown before Atelier copies recovery state (13644.771166ms)
        ✔ interactive child processes suspend and restore Pi's TUI (413.744125ms)
        ✔ interactive child processes fail clearly outside Pi TUI mode (0.448958ms)
        ✔ Jujutsu provider exposes change, commit, operation, workspace, files, and diff (4051.395792ms)
        ✔ Jujutsu observation failures never masquerade as an empty diff (1301.144417ms)
        ✔ Jujutsu task commits finalize only explicitly approved source paths (3753.140791ms)
        ✔ Jujutsu path inventories canonicalize symlinked and macOS-style alias roots (1524.993333ms)
        ✔ Jujutsu observation retries only a transient Atelier runtime-file snapshot race (2687.342667ms)
        ✔ atlr launch starts Pi with the Atelier extension and forwards Pi arguments (2467.609125ms)
        ✔ reviewed task metadata produces one narrow task constraint (17289.609125ms)
        ✔ post-approval retrieval drift does not revoke source-bound execution control (51580.847417ms)
        ✔ pause, resume, and cancellation are atomic and execution resume is idempotent (13284.048042ms)
        ✔ execution evidence attributes only paths changed by the individual operation (12908.976959ms)
        ✔ workflow metadata does not alter source revision bindings or enter a scoped Git commit (14517.300209ms)
        ✔ workflow metadata does not stale source-qualified validation evidence (9175.31825ms)
        ✔ dependency manifests require an explicit dependency contract and never inherit file.write (3790.514167ms)
        ✔ a validation-required workflow cannot approve a task that names no configured required check (783.019834ms)
        ✔ typed model validation reports a failed declared check as a failed tool operation (6482.524667ms)
        ✔ typed reads allow nonexistent in-root targets but reject nonexistent paths below escaping symlinks (4594.375375ms)
        ✔ task closure finalizes workflow metadata and leaves the complete Git repository clean (28054.147875ms)
        ✔ MCP stdio client exchanges bounded JSON-RPC messages without shell interpolation (169.245042ms)
        ✔ every approved workspace root receives a real revision snapshot and secondary drift is observable (25772.285167ms)
        ✔ exact approval and execution resume fail closed when a secondary workspace repository drifts (43816.393166ms)
        ✔ one reviewed task commits, reviews, and closes changes across every approved repository (44438.841ms)
        ✔ task execution contracts support repository-qualified paths without broadening other roots (1.51975ms)
        ✔ navigation parses file locations and opens Helix at an exact line (1.133583ms)
        ✔ real Octocode fixture records a cloud default despite locally available embedding support (0.587709ms)
        ✔ Octocode collector diagnoses a missing development binary before invoking probe commands (1276.117167ms)
        ✔ Octocode collector preflights embeddings, preserves the contract, and gates GraphRAG (4.073875ms)
        ✔ Octocode conformance accepts required tools and warns when GraphRAG is absent (6086.654917ms)
        ✔ real Octocode 0.14.0 project-local run satisfies the complete provider contract (11.458834ms)
        ✔ Octocode comparative evaluation rejects default retrieval while preserving the structural contract (13.616334ms)
        ✔ real Octocode 0.14.0 fixture records that index --force is unsupported (29.910667ms)
        ✔ real Octocode 0.14.0 local fixture returns text MCP evidence that requires normalization (0.796708ms)
        ✔ Octocode adapter indexes and searches multiple repositories through isolated MCP processes (5399.268083ms)
        ✔ Octocode canonicalizes aliased repository roots and absolute result paths (4192.506209ms)
        ✔ Octocode version probes preserve timeout diagnostics instead of reporting a missing executable (750.889416ms)
        ✔ Octocode rejects cloud embedding configuration without the required API key before indexing (586.829292ms)
        ✔ Octocode retries a zero-block project with the supported bare index command (1117.359417ms)
        ✔ real Octocode 0.14.0 contract bounds semantic results and omits GraphRAG when disabled (0.819375ms)
        ✔ real Octocode 0.14.0 fixture preserves the advertised MCP contract (0.780958ms)
        ✔ Octocode development setup writes a project-local FastEmbed configuration without invoking global config (1482.635083ms)
        ✔ Octocode development setup preserves an unmanaged project configuration (758.630458ms)
        ✔ Octocode adapter normalizes real text MCP search, symbol, and GraphRAG responses (3323.244ms)
        ✔ Pi tool outcome classification does not infer interruption from arbitrary error text (1.0835ms)
        ✔ Pi tool outcome classification uses abort state or the exact Bash abort sentinel (0.183334ms)
        ✔ Pi status presentation distinguishes missing plans, execution grants, and VCS identity (0.642583ms)
        ✔ Pi /trust remains independent and Atelier establishes the startup workspace without a trust command (34698.716834ms)
        ✔ Pi extension keeps provider-first discovery advisory while confining typed reads and prompting for shell (21044.463541ms)
        ✔ Atelier footer refreshes model and thinking-level selections immediately (6544.631875ms)
        ✔ direct user shell refreshes VCS dirtiness and index freshness (9021.716375ms)
        ✔ the next Pi input refreshes repository and intelligence state changed while idle (10785.067083ms)
        ✔ Pi code tools retain one retrieval session and enforce inventory-first decisions (7085.643792ms)
        ✔ Pi /plan starts immediately without waiting on Pi idle state (4225.490666ms)
        ✔ Pi automatic ManualEdit review presents exact approval and supports cancellation (3913.607834ms)
        ✔ Pi /execute activates an explicitly requested later approved-plan task (5741.0295ms)
        ✔ Pi focused validation passes the current abort signal and records interruption (6726.544917ms)
        ✔ Pi act mode requires execution-linked permissions and still prompts for destructive commands (27025.722709ms)
        ✔ a denied operation leaves an incomplete active task paused without starting another agent turn (7974.287042ms)
        ✔ an explicit per-turn no-Bash/no-validation/no-commit/no-close instruction is enforced as policy (4815.496417ms)
        ✔ Pi keeps independent repository state for concurrent sessions and closes each session explicitly (3313.251292ms)
        ✔ separate Pi extension registrations retain their own Core factories (985.537583ms)
        ✔ typed workflow tools remain active when code intelligence is disabled (908.159792ms)
        ✔ model Bash and direct user shell share one workspace-policy authorization boundary (1594.555333ms)
        ✔ Pi status, workflow, and code commands append expandable persistent report cards (445.914916ms)
        ✔ Pi /status owns one observation and slash input does not start a competing footer refresh (452.849541ms)
        ✔ parses stable task metadata and dependencies (2.402792ms)
        ✔ reports duplicate IDs, unknown dependencies, cycles, and missing completion criteria (0.313166ms)
        ✔ structural plan diff covers every canonical task field in deterministic order (0.652125ms)
        ✔ structural plan diff reports stable task identity changes as remove and add (0.408875ms)
        ✔ parses canonical multiline task metadata and formats legacy comments for review (0.497375ms)
        ✔ an unchanged plan review is durable completed ManualEdit evidence (38345.589291ms)
        ✔ a completed review records additions, removals, and field edits (12154.899208ms)
        ✔ plan review records canonical configured paths through repository aliases (6892.947334ms)
        ✔ block
  - stderr:
        [test] $ aubr test
        Auto-installing: install state not found
        devDependencies:
        + @types/node@24.13.3
        + typescript@7.0.2

## Capability inventory

- Layout: `single-package`
- Config roots: `.`
- Documentation evidence: `.agents/skills/beads/SKILL.md`, `.beads/README.md`, `AGENTS.md`, `BUILD_REPORT.md`, `CHANGELOG.md`, `CLAUDE.md`, `MIGRATION_REPORT.md`, `README.md`, `apps/pi-extension/README.md`, `docs/ADR-0001-JUJUTSU-FIRST.md`, `docs/ADR-0002-EXTERNAL-CODE-PROVIDERS.md`, `docs/ADR-0003-CODESEARCH-DEFAULT.md`, `docs/ADR-0004-DEGRADED-CODESEARCH-FALLBACK.md`, `docs/ADR-0005-VERIFY-CODESEARCH-VECTOR-INDEX.md`, `docs/ADR-0006-RELEASE-MCP-BEFORE-LOCAL-INDEX.md`, `docs/ADR-0007-CODESEARCH-CORPUS-SELECTION.md`, `docs/ADR-0008-FOCUSED-CODE-RETRIEVAL.md`, `docs/ADR-0009-SEMANTIC-LITERAL-RETRIEVAL-FUSION.md`, `docs/ADR-0010-EXACT-IDENTIFIER-RETRIEVAL-HINTS.md`, `docs/ADR-0011-CODESEARCH-POC-ACCEPTED.md`, `docs/ADR-0012-OCTOCODE-LIVE-CONTRACT.md`, `docs/ADR-0013-TASK-BACKED-WORKING-STATE-RETRIEVAL.md`, `docs/ADR-0014-PI-SQLITE-RUNTIME-COMPATIBILITY.md`, `docs/ADR-0015-DUAL-RUNTIME-SQLITE.md`, `docs/ADR-0016-SQLITE-MISSING-ROW-CONTRACT.md`, `docs/ADR-0017-PLAN-READS-AND-PROVIDER-FIRST-TOOLS.md`, `docs/ADR-0018-APPROVED-REPOSITORY-EXECUTION.md`, `docs/ADR-0019-EXACT-PLAN-EXECUTION.md`, `docs/ADR-0020-OCTOCODE-EMBEDDING-PREFLIGHT.md`, `docs/ADR-0021-OCTOCODE-DEFAULT-RETRIEVAL-REJECTED.md`, `docs/ADR-0022-BACKGROUND-CODE-INDEX-COORDINATOR.md`, `docs/ADR-0023-PI-ACTIVE-CODE-TOOLS.md`, `docs/ADR-0024-PROJECT-TRUST-AND-RUNTIME-STATE.md`, `docs/ADR-0025-TYPED-TASK-CAPABILITIES-AND-UNCONFINED-SHELL.md`, `docs/ADR-0026-AUTHORITATIVE-TASK-COMPLETION.md`, `docs/ADR-0027-WORKSPACE-REVISION-BINDINGS.md`, `docs/ADR-0028-USER-CONTROL-AND-TYPED-VALIDATION.md`, `docs/ADR-0029-EXACT-TASK-SCOPE-AND-SOURCE-ISOLATION.md`, `docs/ADR-0030-REPOSITORY-FINALIZATION-AND-CLOSURE-SEMANTICS.md`, `docs/ADR-0031-TUI-APPROVAL-STATUS-AND-VCS-IDENTITY.md`, `docs/ADR-0032-WORKSPACE-RECOVERABILITY-POLICY.md`, `docs/ADR-0033-PERSISTENT-MARKDOWN-REPORTS.md`, `docs/ADR-0034-EXPANDABLE-REPORT-CARDS.md`, `docs/ADR-0035-EXECUTION-BOUNDARY-AND-WORKSPACE-FINALIZATION.md`, `docs/ADR-0036-INTERACTIVE-OBSERVATION-PIPELINE.md`, `docs/ADR-0037-CANONICAL-PATH-IDENTITY.md`, `docs/ADR-0038-DIRECT-USER-BASH-DENIAL-CONTRACT.md`, `docs/ADR-0039-PI-UI-LIFECYCLE-AND-EVIDENCE.md`, `docs/ADR-0040-EXTERNAL-PROVIDER-STATE-AND-TRANSIENT-SNAPSHOT-RETRY.md`, `docs/ADR-0041-INLINE-PHASES-AND-READABLE-PLAN-AUTHORITY.md`, `docs/ADR-0042-TRANSIENT-PROGRESS-AND-REVIEWED-PLAN-RETRIEVAL.md`, `docs/ADR-0043-LIFECYCLE-EXPLICIT-PHASE-SURFACES-AND-CHRONOLOGICAL-EVIDENCE.md`, `docs/ARCHITECTURE.md`, `docs/CODESEARCH_CORPUS_REPORT_2026-07-22.md`, `docs/CODESEARCH_EVALUATION.md`, `docs/CODESEARCH_EVALUATION_REPORT_2026-07-21.md`, `docs/CODESEARCH_FOCUSED_RETRIEVAL_REPORT_2026-07-22.md`, `docs/CODESEARCH_INDEX_REPAIR_REPORT_2026-07-21.md`, `docs/CODESEARCH_MCP_LOCK_REPORT_2026-07-21.md`, `docs/CODESEARCH_RETRIEVAL_ECONOMY_REPORT_2026-07-27.md`, `docs/CODESEARCH_VECTOR_STORE_REPORT_2026-07-21.md`, `docs/CODE_INTELLIGENCE.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/LOCAL_ACCEPTANCE.md`, `docs/MANUAL_ACCEPTANCE_CORRECTIONS.md`, `docs/OCTOCODE_EVALUATION.md`, `docs/OCTOCODE_INTEGRATION.md`, `docs/PLAN_FORMAT.md`, `docs/REVIEW_CORRECTIONS.md`, `docs/ROADMAP.md`, `docs/ROADMAP_IMPLEMENTATION.md`, `docs/UI_LATENCY_AUDIT_ALPHA29.md`, `docs/UI_LATENCY_CORRECTIONS_ALPHA30.md`, `examples/PLAN.md`
- Test evidence: `tests/acceptance-workflow.test.ts`, `tests/action-classifier.test.ts`, `tests/approval-dialog.test.ts`, `tests/async-process.test.ts`, `tests/authoritative-context.test.ts`, `tests/beads-cli-provider.test.ts`, `tests/cancellation-resume.test.ts`, `tests/canonical-path-end-to-end.test.ts`, `tests/canonical-query.test.ts`, `tests/cli-retrieval.test.ts`, `tests/cli-workflow.test.ts`, `tests/code-budgets.test.ts`, `tests/code-evaluation.test.ts`, `tests/code-result-presentation.test.ts`, `tests/code-search-focus.test.ts`, `tests/code-service.test.ts`, `tests/code-workspace.test.ts`, `tests/codesearch-accepted-fixture.test.ts`, `tests/codesearch-collection.test.ts`, `tests/codesearch-corpus-clean-fixture.test.ts`, `tests/codesearch-fixture-updater.test.ts`, `tests/codesearch-focused-retrieval-fixture.test.ts`, `tests/codesearch-identifier-hints-fixture.test.ts`, `tests/codesearch-ignore.test.ts`, `tests/codesearch-index-lock-fixture.test.ts`, `tests/codesearch-probe-summary.test.ts`, `tests/codesearch-provider.test.ts`, `tests/codesearch-real-fixture.test.ts`, `tests/codesearch-unbuilt-vector-fixture.test.ts`, `tests/codesearch-vector-failure-fixture.test.ts`, `tests/codesearch-vector-repaired-fixture.test.ts`, `tests/core.integration.test.ts`, `tests/execution-evidence.test.ts`, `tests/execution-workflow.test.ts`, `tests/footer-presentation.test.ts`, `tests/guided-verification.test.ts`, `tests/interactive-performance.test.ts`, `tests/interactive-process.test.ts`, `tests/jujutsu-repository-provider.test.ts`, `tests/launcher.test.ts`, `tests/manual-acceptance-corrections.test.ts`, `tests/mcp-stdio-client.test.ts`, `tests/multi-repository-correctness.test.ts`, `tests/multi-repository-execution-scope.test.ts`, `tests/navigation.test.ts`, `tests/octocode-cloud-prerequisite-fixture.test.ts`, `tests/octocode-collector.test.ts`, `tests/octocode-conformance.test.ts`, `tests/octocode-conformant-fixture.test.ts`, `tests/octocode-evaluated-fixture.test.ts`, `tests/octocode-index-flag-fixture.test.ts`, `tests/octocode-local-text-fixture.test.ts`, `tests/octocode-provider.test.ts`, `tests/octocode-real-contract.test.ts`, `tests/octocode-real-fixture.test.ts`, `tests/octocode-setup.test.ts`, `tests/octocode-text-response.test.ts`, `tests/pi-execution-outcome.test.ts`, `tests/pi-extension.test.ts`, `tests/plan-parser.test.ts`, `tests/plan-review-workflow.test.ts`, `tests/plan-scope-editor.test.ts`, `tests/process-environment.test.ts`, `tests/reconciliation-state.test.ts`, `tests/recovery-manager.test.ts`, `tests/redaction-retention.test.ts`, `tests/report-presentation.test.ts`, `tests/report-renderer-runtime.test.ts`, `tests/repository-path.test.ts`, `tests/repository-provider-correctness.test.ts`, `tests/repository-state-planner.test.ts`, `tests/retrieval-config.test.ts`, `tests/retrieval-ledger.test.ts`, `tests/sandbox.test.ts`, `tests/security-boundary.test.ts`, `tests/self-hosting-retrieval-acceptance.test.ts`, `tests/service.test.ts`, `tests/smoke-cleanup.test.ts`, `tests/sqlite-runtime.test.ts`, `tests/status-view.test.ts`, `tests/test-environment-isolation.test.ts`, `tests/test-environment.test.ts`, `tests/validation-service.test.ts`, `tests/workflow-guard.test.ts`, `tests/working-state-retrieval-persistence.test.ts`, `tests/workspace-policy.test.ts`
- CI workflows: `.github/workflows/ci.yml`, `.github/workflows/live-conformance.yml`
- Ambiguities: none

### Packages

- `.`
  - Manifests: `package.json`
  - Test evidence: `tests/acceptance-workflow.test.ts`, `tests/action-classifier.test.ts`, `tests/approval-dialog.test.ts`, `tests/async-process.test.ts`, `tests/authoritative-context.test.ts`, `tests/beads-cli-provider.test.ts`, `tests/cancellation-resume.test.ts`, `tests/canonical-path-end-to-end.test.ts`, `tests/canonical-query.test.ts`, `tests/cli-retrieval.test.ts`, `tests/cli-workflow.test.ts`, `tests/code-budgets.test.ts`, `tests/code-evaluation.test.ts`, `tests/code-result-presentation.test.ts`, `tests/code-search-focus.test.ts`, `tests/code-service.test.ts`, `tests/code-workspace.test.ts`, `tests/codesearch-accepted-fixture.test.ts`, `tests/codesearch-collection.test.ts`, `tests/codesearch-corpus-clean-fixture.test.ts`, `tests/codesearch-fixture-updater.test.ts`, `tests/codesearch-focused-retrieval-fixture.test.ts`, `tests/codesearch-identifier-hints-fixture.test.ts`, `tests/codesearch-ignore.test.ts`, `tests/codesearch-index-lock-fixture.test.ts`, `tests/codesearch-probe-summary.test.ts`, `tests/codesearch-provider.test.ts`, `tests/codesearch-real-fixture.test.ts`, `tests/codesearch-unbuilt-vector-fixture.test.ts`, `tests/codesearch-vector-failure-fixture.test.ts`, `tests/codesearch-vector-repaired-fixture.test.ts`, `tests/core.integration.test.ts`, `tests/execution-evidence.test.ts`, `tests/execution-workflow.test.ts`, `tests/footer-presentation.test.ts`, `tests/guided-verification.test.ts`, `tests/interactive-performance.test.ts`, `tests/interactive-process.test.ts`, `tests/jujutsu-repository-provider.test.ts`, `tests/launcher.test.ts`, `tests/manual-acceptance-corrections.test.ts`, `tests/mcp-stdio-client.test.ts`, `tests/multi-repository-correctness.test.ts`, `tests/multi-repository-execution-scope.test.ts`, `tests/navigation.test.ts`, `tests/octocode-cloud-prerequisite-fixture.test.ts`, `tests/octocode-collector.test.ts`, `tests/octocode-conformance.test.ts`, `tests/octocode-conformant-fixture.test.ts`, `tests/octocode-evaluated-fixture.test.ts`, `tests/octocode-index-flag-fixture.test.ts`, `tests/octocode-local-text-fixture.test.ts`, `tests/octocode-provider.test.ts`, `tests/octocode-real-contract.test.ts`, `tests/octocode-real-fixture.test.ts`, `tests/octocode-setup.test.ts`, `tests/octocode-text-response.test.ts`, `tests/pi-execution-outcome.test.ts`, `tests/pi-extension.test.ts`, `tests/plan-parser.test.ts`, `tests/plan-review-workflow.test.ts`, `tests/plan-scope-editor.test.ts`, `tests/process-environment.test.ts`, `tests/reconciliation-state.test.ts`, `tests/recovery-manager.test.ts`, `tests/redaction-retention.test.ts`, `tests/report-presentation.test.ts`, `tests/report-renderer-runtime.test.ts`, `tests/repository-path.test.ts`, `tests/repository-provider-correctness.test.ts`, `tests/repository-state-planner.test.ts`, `tests/retrieval-config.test.ts`, `tests/retrieval-ledger.test.ts`, `tests/sandbox.test.ts`, `tests/security-boundary.test.ts`, `tests/self-hosting-retrieval-acceptance.test.ts`, `tests/service.test.ts`, `tests/smoke-cleanup.test.ts`, `tests/sqlite-runtime.test.ts`, `tests/status-view.test.ts`, `tests/test-environment-isolation.test.ts`, `tests/test-environment.test.ts`, `tests/validation-service.test.ts`, `tests/workflow-guard.test.ts`, `tests/working-state-retrieval-persistence.test.ts`, `tests/workspace-policy.test.ts`

### Proposed commands

- `root-mise-test` (tests): argv=`mise run test`; cwd=`.`; provenance=`mise.toml`

### CI command evidence

- `.github/workflows/ci.yml:26`: `npm ci --ignore-scripts` (ci-evidence-only)
- `.github/workflows/ci.yml:27`: `npm run check` (ci-evidence-only)
- `.github/workflows/ci.yml:28`: `npm pack --dry-run` (ci-evidence-only)
- `.github/workflows/live-conformance.yml:23`: `aube install --frozen-lockfile` (ci-evidence-only)
- `.github/workflows/live-conformance.yml:24`: `aubr build` (ci-evidence-only)
- `.github/workflows/live-conformance.yml:25`: `scripts/live-conformance.sh "${{ matrix.target }}"` (ci-evidence-only)
- `.github/workflows/live-conformance.yml:36`: `aube install --frozen-lockfile` (ci-evidence-only)
- `.github/workflows/live-conformance.yml:37`: `aubr build` (ci-evidence-only)
- `.github/workflows/live-conformance.yml:38`: `scripts/live-conformance.sh "${{ matrix.target }}"` (ci-evidence-only)
