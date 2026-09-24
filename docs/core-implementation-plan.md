# Core implementation and verification plan

**Status:** Proposed implementation plan. Creating this plan does not mean its features, test harnesses, or release claims are implemented.

**Created:** 2026-09-24. Tool research checked on this date.

**Goal:** An Effect-native, application-neutral plugin runtime with explainable execution, substitutable implementations, reliable lifetimes, and evidence-backed performance and correctness claims.

## 1. Outcome and constraints

We are building a small runtime whose default application will eventually be an agent harness—not an agent framework embedded in the core.

The final outcome must demonstrate:

1. Managed operations carry correct ownership, composition, causality, and outcome evidence.
2. Independently authored plugins implement shared behavioral contracts without privileged first-party access.
3. Cancellation, activation failure, recorder failure, and shutdown never silently masquerade as success.
4. Scoped overrides and supported composition changes cannot leak registrations, mix revisions, or let stale managed handles affect successors.
5. Required recorded evidence has explicit acknowledgement, durability, retention, and recovery semantics.
6. A failure found in controlled simulation can be reproduced locally from a retained scenario.
7. Real Bun processes and real storage satisfy the supported guarantees beyond the simulator.
8. Performance and authoring claims are measured against equivalent alternatives.

### Fixed constraints

- Bun for application execution and tests; Effect for execution, dependencies, typed failure, scopes, concurrency, cancellation, and streams.
- Do not implement another fiber scheduler, dependency constructor, or resource manager alongside Effect.
- Trusted, in-process plugins. Neither dependency visibility nor child scopes are security sandboxes.
- All application behavior remains replaceable. Core identity, ownership, and evidence rules form the small fixed contract.
- Programmatic composition first. Package discovery, configuration loading, transports, journals, exporters, and clients are separate modules/plugins.
- Stable execution composition. No arbitrary mid-operation code replacement; supported changes occur through explicit preparation and publication or a declared restart.
- Preserve the existing app/C++ scaffolds and unrelated working-tree changes. No commits or publication are implied by this plan.
- No external testing service, upload, or paid infrastructure is required. Antithesis is an optional later evaluation requiring separate approval.

### What verification means

No finite test campaign proves arbitrary TypeScript plugins correct. We will publish **invariants, a fault model, checked configurations, exercised scenarios, and remaining limits**. Model checking proves properties of the stated finite model; tests establish evidence about the implementation. Neither is a blanket proof about all production behavior.

## 2. Current baseline

The current `packages/core/` implements graph validation, declared dependency/export checks, fixed-composition startup, rollback, scoped work, reverse disposal, typed around hooks, continuation guards, native Effect spans, and detached inspection.

There are 27 runtime tests and compile-time interface checks, verified in the preceding implementation work. These results remain useful; adding this document did not require rerunning unchanged checks.

Known gaps include untraced direct capability calls and zero-handler hook execution; absent operation/composition identities; no durable journal or replay protocol; no hierarchical capability composition; no runtime health policy or controlled replacement.

### Tool feasibility checked during planning

On Darwin, through `nix develop`, using Bun 1.3.13 and Effect 3.22.2:

- An Effect `TestClock` advanced one virtual hour through the existing `core.run` interface.
- `effect/FastCheck` (fast-check 3.23.2 in the current lockfile) executed 100 generated command sequences against current core invocation/closure and resource ownership.
- Result: **2 tests passed, 775 assertions, no failures**.

These were temporary feasibility probes, not a complete model-based suite, a deterministic simulator, or proof that the core is reliable. No new tool dependency was installed. Current sources expose fast-check through Effect's public `effect/FastCheck` module.

## 3. Testing tools: adopt, adapt, or defer

| Tool/approach | Decision | Purpose and limitation |
| --- | --- | --- |
| `bun:test` + TypeScript | Keep | Fast regression, integration, and negative type checks; run the production runtime. |
| Effect `TestContext`, `TestClock`, `Deferred`, test/random facilities | Adopt | Virtual time and controlled completion/cancellation. A virtual clock does not control arbitrary Promises, OS I/O, or all scheduling. [4] |
| `effect/FastCheck` | Adopt | Generate graphs, commands, payloads, faults; shrink failures; retain seed/path/replayPath. Use the lockfile-compatible version, not mixed generator versions. [3] |
| Small Basis-specific simulation driver | Build | Drive real core code through controlled adapters and check protocol invariants. It orchestrates scenarios; it is not another Effect runtime. |
| TLA+ with TLC | Adopt narrowly | Check finite lifecycle/publication/ownership models, including safety and conditional liveness. Do not attempt to model Effect internals or all plugin code. [5] |
| Real child-process fault harness | Build | Abrupt process death, restart, journal recovery, finalizer absence, hung plugins, actual filesystem behavior. |
| Semantic mutation corpus | Required | Deliberately break important guarantees and require the suite to catch each fault. |
| StrykerJS command runner | Pilot, then adopt if viable | Run Bun tests against generated mutants with coverage optimization disabled. It supports arbitrary test commands, but this exact integration has not been verified; do not assume a first-party Bun runner. [6] |
| TigerBeetle VOPR | Learn from, do not import | Its simulator runs real TigerBeetle consensus/storage code against simulated time, disk, and network. It is specialized infrastructure, not a general TypeScript testing package. [1,2] |
| Antithesis | Optional later | Broader deterministic execution of Linux x86-64 containers. Requires integration/access, packaged or mocked dependencies, and approval to upload. Bun compatibility must be trialed; the Mac is not its execution target. [7] |
| Jepsen-style distributed tests | Defer | Appropriate if we later promise cross-machine coordination/consistency. Multiple clients connected to one daemon do not by themselves require a consensus test framework. |

The key TigerBeetle lesson is **production code + controlled nondeterminism + strong checkers + repeatable failures**, not simply a very high test count. Its protocol-aware tests also check internal consistency, complementing observable contract tests. [1,2]

## 4. Module layout and interfaces

Keep public interfaces small. Prefer modules with depth: callers declare a contract or run an operation; the implementation handles attribution, cancellation, evidence, and ownership consistently.

Proposed ownership, not a mandate to create every file immediately:

| Location | Responsibility |
| --- | --- |
| `packages/core/src/` | Plugin contracts, managed operations, composition, ownership, lifecycle/health, runtime evidence envelope, inspection interface |
| `packages/core/src/internal/` | Resolution, dispatch, scope ownership, revision publication, evidence coordination; expensive invariant checks where needed |
| `packages/core/tests/` | Behavior/type regressions, generated properties, lifecycle and composition models |
| `packages/core-testkit/` | Reusable conformance suites, scenario driver, deterministic adapters, independent history checkers; test-only dependency |
| `packages/journal-sqlite/` | First durable journal adapter using Bun's SQLite integration; transactional storage details stay here |
| `packages/journal-file/` | Second, independently implemented durable adapter with a deliberately small append-only format |
| `packages/core-inspector/` | CLI/query client using only public inspection/evidence interfaces |
| `tests/core-system/` | Process controller, abrupt-death fixtures, separately packaged plugins, real I/O and long-running checks |
| `verification/core/` | TLA+ specifications, finite model configurations, model-to-code mapping |
| `packages/core/bench/` | Isolated benchmarks and comparable Cordis adapters |

The testkit's in-memory journal is **not** evidence that a second durable backend works. Both durable adapters must pass the same relevant contract suite. Do not build indexing, replication, compaction, or a general database into the file journal.

### Interfaces to settle before expanding implementation

1. **Capability contract:** stable identity, contract version, Effect tag, managed operation declarations, compatibility rules. Separate implementation version from contract compatibility. Start with explicit compatible contract majors; no package-version solver.
2. **Managed operation:** input/output/error codecs or an explicit opaque classification; unary or stream behavior; execution/recording policy; owner and composition binding. The interface stays Effect-native.
3. **Plugin manifest:** provided/required contracts, configuration schema, implementation provenance, resources, and startup requirements. First- and third-party plugins use the same declaration.
4. **Journal:** append identity/order, acknowledgement, flush receipt, recovery, close, retention visibility, and advertised durability capabilities.
5. **Composition scope/revision:** explicit parent sharing and overrides, execution leases, preparation/publication, lifecycle and health.
6. **Inspection:** versioned detached snapshots and bounded updates; no live mutable core objects or implicit evaluation privileges.

Prototype two operation declaration shapes before choosing one: a bound operation descriptor and a schema-declared capability object whose managed methods are bound once. Evaluate both with an external consumer, interceptor, stream, and replacement provider. Choose one; do not retain competing public dispatch systems.

## 5. Verification architecture

```text
seed + generated scenario + fault decisions
                    |
                    v
          scenario driver / virtual time
                    |
       real core, real Effect execution
         /          |               \
 controlled      journal/IO       fixture plugins
 clock/IDs       adapters        and interceptors
                    |
         independent observable history
                    |
      reference model + invariant checkers
                    |
 scenario shrinking + local replay + regression

same contract fixtures -> real Bun subprocesses -> real storage/crashes
finite protocol model -> TLC -> counterexamples mapped to regression cases
```

### Independent oracles

- The reference model uses simple sets, maps, ownership counts, revision bindings, accepted/durable prefixes, and legal transitions.
- It must not import production graph traversal, dispatch, state-transition, or recovery implementations. Shared protocol types/codecs are acceptable; shared decision algorithms would compare the implementation to itself.
- Verify observable behavior through the public interfaces. Supplement it with runtime invariant assertions and read-only internal consistency checks, not tests that mutate private registries.
- Use an independent driver history/resource ledger to check trace completeness. Counting only the spans emitted by the tracer cannot detect a missing operation span.
- For concurrency, compare legal partial orders, not a single artificial global sequence. Require linearization only for operations that promise it: publication, admission relative to close, and journal append/flush ordering.

### Controlled nondeterminism

Use Effect's time/random facilities, injected ID sources, and `Deferred`-gated adapters for operation completion, journal acknowledgement, resource acquisition/release, and background work.

Do not rely on global fake timers or wrap only the final `Effect.runPromise` and call it deterministic. fast-check's Promise scheduler controls wrapped resolutions, not the underlying execution or unwrapped I/O. [3]

The simulation lane must inventory every nondeterministic input. Ban or detect direct native timers, uncontrolled randomness, filesystem/network use, and environment reads in simulation fixtures. Avoid private Effect scheduler hooks. Production-scheduler stress tests remain a separate lane.

**Determinism gate:** replay a scenario repeatedly under the pinned build and compare the complete normalized history and checker result. Normalize only declared nondeterministic presentation fields; never normalize away operation order or outcomes. If it differs, report a replayability defect and narrow the claimed controlled surface. Same-seed input generation alone is not deterministic execution.

### Simulation commands and fault dimensions

Generate both legal actions and intentional invalid actions; preconditions must not filter away rejection behavior.

- Mount valid/invalid graphs; duplicate/missing/incompatible contracts; cyclic graphs.
- Start unary/stream operations, nested calls, retries with distinct attempt IDs, and interceptor chains.
- Register/dispose contributions; call `next` repeatedly or after completion; mutate retained input/output values.
- Fork/cancel/join owned work; fail initialization or a background job; fail or stall cleanup.
- Create children, override providers, close parent/child, retain and use stale handles.
- Prepare/publish/abort replacement; race admission, cancellation, closure, and observer attachment.
- Append/flush/close/read records; delay/fail acknowledgement; duplicate batch identities; fill bounded queues.
- Disconnect/reconnect observers; supply incompatible records or corrupted/torn storage.
- Crash at named checkpoints; recover into a new epoch; attempt callbacks from an old epoch.

A simulated crash snapshots the stable image **before cleanup**, discards volatile state, and prevents old-epoch cleanup from changing that image. It is not modeled as orderly scope closure. Real process-kill tests independently validate the no-finalizers case.

Simulating the runtime against a journal contract does not simulate SQLite internals. The file adapter can run its real encoding/recovery logic against a simulated byte store; SQLite requires real-process/database tests as well.

### Finite model configurations

Start with separate small models rather than one unmanageable Cartesian product:

- **Lifecycle:** two plugins with one dependency edge, two concurrent callers, one background task, activation failure, repeated/concurrent close, and successful/failing/blocked cleanup.
- **Publication/ownership:** two revisions, two active execution leases, a root with two children, one shared provider, and competing prepare/publish/abort/close actions.
- **Journal protocol:** three ordered batches, two flush requests, acknowledgement loss, process crash, and recovery of accepted versus durable prefixes.

These are proposed initial bounds, not checked results. Expand one dimension at a time after complete exploration. Document fairness assumptions and turn off perpetual fault injection when checking progress. Export counterexample action sequences into named implementation regressions. Check implementation histories against the model's legal transitions at named linearization points; maintain that mapping as code changes. This is conformance evidence, not a machine-checked refinement proof of TypeScript.

### Failure artifacts

Every failure includes source revision/content fingerprint, lockfile/tool versions, platform, original and minimized scenario, seed, fast-check path/replayPath where applicable, explicit scheduling/fault decisions, input provenance, observed history, and failed invariant IDs. Retain a serialized minimized scenario in addition to a seed, since generator changes can alter seeded output.

Shrinking must preserve fault checkpoints and the failure predicate. A shrunk deadlock is not a successful reduction of an ownership corruption unless it violates the same asserted invariant. Use external watchdogs for hangs. Put large logs in CI artifacts; keep only small meaningful regression scenarios in the repository.

## 6. Invariant catalogue and claim limits

These IDs connect implementation work, tests, model checks, and release evidence.

| ID | Required property |
| --- | --- |
| G1 | Invalid composition rejects before any application plugin activation. |
| G2 | One selected provider per contract per realm; only declared dependencies are visible. |
| O1 | Every registration/resource/task has one owner; cleanup is not applied to a successor instance. |
| O2 | Managed operations cannot begin after their owner/revision stops admitting work. |
| O3 | Children cannot remove sibling/parent contributions or prematurely close shared resources. |
| L1 | Cooperatively terminating owned work is drained/interrupted before its resources close; repeated closure joins the same result. |
| L2 | Acquisition, operation, and finalizer failures retain typed failure/defect/interruption structure. |
| L3 | Once injected faults stop, fair scheduling and terminating plugins permit progress or an explicit terminal failure. No infinite-fault availability promise. |
| T1 | Every admitted managed operation has attributable start evidence and one terminal outcome, or a recoverable incomplete state. Pre-admission rejections are separately identifiable. |
| T2 | Caller/provider identities, parent links, attempts, and composition revisions remain correct across async work and streams. |
| T3 | Retained values cannot alter historical records; transformation/short-circuit decisions remain attributable. |
| J1 | Accepted journal records are ordered and immutable; conflicting duplicate identities reject. |
| J2 | A successful durability receipt survives the stated crash model, or corruption is explicitly reported; recovery never fabricates acknowledged content. |
| J3 | Required evidence never silently drops; memory, queues, payloads, and retained inspection history have explicit limits. |
| P1 | Publication is atomic for admitted work: one invocation uses one coherent revision, including nested managed calls. |
| P2 | Failed stageable preparation does not replace the current revision; unsupported stateful changes require restart/migration. |
| S1 | Policy-controlled secrets/fields do not appear at disallowed destinations; recorder/codec failures never cause raw-data fallback. |
| R1 | Playback performs no unrecorded external side effects and explicitly refuses missing/incompatible evidence. |

A plugin that loops synchronously can block the entire process. A timeout cannot prove an uninterruptible finalizer stopped. A crash between an external side effect and its recorded result leaves an unknown outcome. Checksums detect specified corruption, not malicious tampering. A trusted plugin can bypass managed interfaces. All are part of the documented limits, not test-suite excuses to claim stronger guarantees.

## 7. Phased implementation

Each phase lands implementation, meaningful tests, and current-use documentation together. Do not build all features and add the verification system afterward.

### Phase 0 — Contract, fault model, and test foundation

**Dependencies:** none. **Scope:** G1–G2, initial O/L invariants; all later gates depend on this.

Work:

- Translate this plan's guarantees into the core's authoritative interface documentation; retain invariant IDs alongside their executable tests rather than duplicating changing contract prose everywhere.
- Establish lifecycle states separately from health: e.g. starting/ready/draining/closed versus healthy/degraded/failed. Specify transitions, close idempotence, failure composition, and legal admission points.
- Define operation admission/publication/journal linearization points and the supported process-crash/storage fault assumptions.
- Add testkit helpers, generated graph/lifecycle commands, a simple independent model, controlled ID/time/I/O fixtures, replay files, and external watchdog execution.
- Capture the existing behavior and benchmark baseline without rewriting unrelated code.
- Add initial finite TLA+ lifecycle/ownership model and TLC configuration. Make the tool available through project tooling/Nix; do not install global tools ad hoc.
- Pilot Stryker's command runner against one small pure module. Verify it mutates the executed source and that a known mutant fails; otherwise retain the manual semantic corpus while investigating integration.

**Gate:** existing tests preserved; a seeded lifecycle case replays; a deliberately omitted cleanup is caught; invalid graphs never activate fixtures; the finite model completes its declared state-space check. Report model bounds/state count, not simply “TLA passed.”

### Phase 1 — Capability contracts and operation interface

**Dependencies:** Phase 0.

Work:

- Select the operation declaration shape using the two prototypes described above.
- Add compatible contract identities/versions, explicit operation modes, configuration schemas, and startup diagnostics. Reuse Effect Schema where suitable.
- Keep raw opaque capability values supported only with explicit trace/replay limitations; do not imply that arbitrary imported functions are managed.
- Bind provider ownership once, preserving invocation-local caller context. Do not capture activation span/parentage in callable implementations.
- Preserve declared-dependency rules and Effect environment typing, including requirements supplied by callers outside the composition.
- Migrate the existing example and test fixtures. Remove superseded internal dispatch paths rather than layering a second lifetime system over them.

**Gate:** positive/negative type checks; incompatible contracts reject before activation; two separately defined providers work with the unchanged consumer; no first-party-only access. Existing scope/cause tests remain green.

### Phase 2 — Complete managed execution and interception evidence

**Dependencies:** Phase 1.

Work:

- Add runtime/scope/activation/revision/invocation/attempt IDs and immutable composition records, including source/configuration provenance and explicit opaque fields.
- Instrument the managed call path even with no interceptors. Record admission, decisions, result/failure/interruption, and links for detached-but-owned background work.
- Unify operation interception with existing hook semantics. Record pass/transform/reject/short-circuit behavior without requiring full payload copies.
- Establish snapshot/mutation policy and bounded codec/artifact behavior before persisting payloads. Provide structural secret exclusion from the beginning.
- Give streams managed consumption lifetimes: construction is not successful completion. Record end/failure/cancellation when consumption settles, including early consumer exit and bounded chunk capture.
- Separate policy interceptors from optional observation delivery. Observer exceptions must not replace operation results.

**Gate:** independent fixture counters match evidence for zero/one/many handlers, nesting, concurrent calls, retry attempts, and streams; parentage/revision checks pass; unknown/oversized/nonserializable payloads follow declared policy; no double terminal records. Required recorder failures cannot be mistaken for complete evidence.

### Phase 3 — Lifecycle supervision and robust closure

**Dependencies:** Phase 2; can overlap journal design, not its acceptance gate.

Work:

- Introduce owned background-work registration with exit reporting; required work failure changes health/admission according to explicit policy. Optional job failure remains observable.
- Add initialization, drain, and cleanup deadline policies. A deadline reports incomplete cleanup and can request host escalation; it must not free resources underneath still-running work while reporting clean closure.
- Preserve original and finalizer causes. Ensure shutdown joins concurrent closers and every registered cleanup remains accounted for through quiescence.
- Exercise reentrant disposal, cleanup-time registration rejection, pending activation, teardown observer errors, and stale disposer cases from DSH's documented hardening history. [8]
- Add internal ownership consistency checks and paired public behavior assertions.

**Gate:** generated fault scenarios preserve O1/O2/L1/L2; a fault-free suffix satisfies L3 under stated fairness assumptions; process watchdog tests handle non-cooperative fixtures without hanging the suite. “Deadline exceeded” is distinct from “closed successfully.”

### Phase 4 — Journal protocol, recording policy, and privacy

**Dependencies:** Phases 2–3.

Work:

- Define versioned runtime records, bounded payload/artifact references, append batch identity, sequencing, and recovery rules. Retry/duplicate behavior must be idempotent for an identical accepted batch and reject conflicting reuse.
- Separate accepted-in-memory, durably committed, and exported receipts. An in-memory adapter cannot satisfy a durable requirement.
- Provide explicit recording modes. Diagnostic mode may declare sampling/gaps; required-audit mode cannot silently drop. In strict durable execution, commit required start/intent evidence before external work and required outcome evidence before reporting durable completion.
- Keep operation result distinct from evidence completion: if an external effect succeeded but outcome recording failed, expose the recording failure/uncertainty without claiming the external action was rolled back or safe to retry.
- Define bounded queue/backpressure policy, error escalation, cancellation during append/flush, and shutdown ordering.
- Solve recorder bootstrap through a public infrastructure contract/phase usable by third parties. Required application admission waits for recorder readiness; bound pre-readiness diagnostics; drain the recorder last. Recorder internals do not recursively invoke their own recording path, but recorder health is observable.
- Apply policy before protected storage/export destinations. Distinguish metadata-only, redacted, and explicitly authorized richer capture. Provide local retention limits and an explicit unavailable/expired artifact outcome.

**Gate:** a fake journal can fail every protocol step without silent loss or recursive recording; saturated queues remain bounded; all record shapes including causes contain only permitted canary fields; disabling remote export preserves local required recording; swapping journal implementations needs no core patch.

### Phase 5 — Real durability and crash recovery

**Dependencies:** Phase 4.

Work:

- Build the SQLite adapter first, with explicit transaction/synchronization settings, writer ownership, append/flush/close semantics, and platform-specific durability assumptions verified against SQLite/Bun documentation during implementation.
- Build the small file adapter independently. Define framed records/checksums, committed-prefix versus torn-tail handling, flush and directory metadata requirements where applicable, and writer ownership. Use established platform locking or explicitly narrow the supported ownership model; do not improvise stale-lock recovery and claim cross-process safety.
- Both durable adapters run the same semantic contract suite. Any difference in crash/writer guarantees is declared and checked at composition time, not hidden behind the same advertised capability.
- Add a real Bun subprocess controller and named write/acknowledgement checkpoints. Kill without graceful shutdown, restart with the same data, and compare receipts observed by the parent with recovered records.
- Test disk-full/permission/I/O failure, malformed lengths, checksum failures, duplicate writers under the advertised model, partial tails, incompatible versions, and pending append versus close.
- Use simulated byte storage to explore write/flush loss/reordering within the file adapter's stated storage model. Do not claim process-kill tests simulate loss of the OS page cache or sudden power failure.

**Gate:** both adapters preserve promised durable receipts after abrupt process death, reject committed-prefix corruption, recover allowed tails, and never report flush success when injection prevented the required commit. The support matrix separately identifies process crash, modeled power loss, and physically tested host/storage failure. Unsupported power-loss claims remain unsupported.

### Phase 6 — Reconstruction, controlled playback, and inspection

**Dependencies:** Phase 5.

Work:

- Build an independent reader that reconstructs operation trees, decisions, composition changes, incomplete attempts, and artifact availability from the journal.
- Add opt-in replay codecs/adapters for declared nondeterministic operations. Separate timeline reconstruction, recorded-I/O playback, and fresh re-execution in both types and documentation.
- Give playback a restricted test environment that rejects live network/filesystem/model/tool effects unless explicitly part of the replay mechanism. This is an enforcement/testing mode for cooperative plugins, not a security sandbox.
- Version codecs and migrations. Unknown required record vocabulary fails closed; optional ignorable metadata cannot silently replace missing required evidence.
- Add bounded inspection streams, snapshot/cursor handshake, gap detection, resynchronization, and a small read-only CLI. Test a second client using the same public interface.

**Gate:** a recorded run can be explained without the original live core; playback makes zero fixture-counted live external calls; missing/expired/redacted evidence is explicitly non-replayable; old records remain attributable; observer overflow cannot block or corrupt required execution.

### Phase 7 — Hierarchical composition and safe replacement

**Dependencies:** Phases 3–6. Add the finite publication model before implementing transitions.

Work:

- Define explicit inherited/shared capability rules and child overrides. Shared resources remain parent-owned; child registrations and handles remain child-owned. Define shutdown of the complete scope tree.
- Add immutable revision bindings and an execution lease so nested managed calls retain their admitted composition.
- Implement an inspectable change plan: affected dependency closure, configuration/contract compatibility, staging eligibility, and restart/migration requirements.
- Support prepare/publish/drain only for genuinely stageable changes. Preparation cannot undo arbitrary external side effects; exclusive/stateful resources must opt into a safe staging protocol or require restart.
- Initially publish at explicit idle/safe points. Concurrent replacement requests serialize or reject with an explicit conflict. Old managed handles never silently retarget the new implementation.
- Extend the TLA+ model to admission, two competing revisions, active leases, parent/child ownership, abort, close, and recording/publication ordering. Map its steps to concrete linearization points.
- Inject failure before/after each staging/publication checkpoint. Recovery must be able to determine which composition was actually committed; do not publish an unrecorded revision and report durable success.

**Gate:** P1/P2 and O3 pass finite model checks, generated command tests, and real scheduler stress. Failed stageable activation leaves the old revision usable. A retained stale handle cannot affect a successor. Stateful changes without a safe protocol are explicitly refused/restart-required, not presented as transactional.

### Phase 8 — Public plugin kit and replacement demonstration

**Dependencies:** Phases 1–7.

Work:

- Package the contract/conformance kit, authoring example, configuration validation, and compatibility diagnostics. Test duplicate SDK/contract installations and declared supported Effect versions.
- Build a non-agent fixture application using a work executor, transformation/policy plugin, journal, and inspector. No model/provider/product-specific logic belongs in core.
- Supply two meaningfully different execution adapters and both durable journal adapters. Replace them by composition without editing consumers.
- Load a fixture built outside the workspace from only the documented exports, first with standard programmatic imports. Package discovery/installation remains separate.
- Ask an independent author/reviewer to complete matched Cordis/Basis tasks. Until someone independent does that, record self-authored examples as self-authored; do not claim external usability validation.

**Gate:** the same contract tests pass across adapters; the packaged fixture uses no internal imports or privileged registration; configurations fail with actionable diagnostics; replacements preserve the declared behavioral and durability profile.

### Phase 9 — Comparative evidence and release qualification

**Dependencies:** baseline begins in Phase 0; final qualification follows Phase 8.

Work:

- Maintain adapters for upstream Cordis, DSH's vendored Cordis, and Basis as separate pinned baselines. Keep the earlier Basis version as a regression baseline where practical.
- Compare matched workloads/guarantees, including equivalent recording sinks, redaction, ownership, and cancellation. Unsupported features are capability differences, not zero-cost performance wins.
- Measure cold import/startup, ready time, dependency footprint, idle/active memory, dispatch, end-to-end latency, event-loop delay, allocation/GC, cancellation, shutdown, and trace completeness.
- Use 0/1/8/32 interceptors, small/large permitted payloads, deep/narrow and wide graphs, shared/isolated scopes, concurrent unary/stream workloads, and slow/unavailable recorders.
- Publish distributions and raw samples from repeated fresh processes. Warm batch averages are not p99 request latency. Separate trace-disabled, diagnostic, and required-durable modes.
- Use same-runtime comparisons where supported; publish native Bun-versus-Node deployment results separately. Do not benchmark unsupported Cordis loader behavior as a performance failure.
- Set numerical latency/memory budgets from representative workloads before optimizing. Initial CI regression thresholds must account for measured noise; do not invent a microsecond target from existing unrecorded dispatch.
- Run the qualification campaigns and produce a dated evidence summary with exact build/tool/platform identifiers and invariant coverage.

**Gate:** all supported guarantees have positive tests, negative/fault tests, and attributable evidence; required semantic mutants are detected; no unresolved safety counterexample or unexplained replay nondeterminism remains; performance tradeoffs and unsupported fault domains are public. Claim specific improvements, not universal superiority.

## 8. Mutation tests: verify the verifier

Before trusting a checker, demonstrate that it rejects a known violation. Maintain a curated semantic corpus in disposable build copies; never mutate the working tree to run it.

Required examples:

- Remove a finalizer registration or close a provider before active work.
- Let a closed owner admit a new operation or let an old disposer remove a successor registration.
- Resolve a nested call against the latest revision instead of its admitted revision.
- Omit the zero-interceptor start record or emit two terminal records.
- Keep a mutable reference instead of snapshotting recorded data.
- Swallow a required recorder error or drop a full-queue record.
- Return a durability receipt before the storage barrier completes.
- Accept a corrupted committed prefix or conflicting duplicate batch.
- Remove a secret-field exclusion.
- Re-execute a live external call during playback.

Each mutant must be detected by its intended invariant/checker, not merely fail TypeScript compilation. Timeouts count only where progress/termination is the property under test; a watchdog hang does not establish that a privacy or trace checker works. Review equivalent/unreachable automatic mutants individually; a raw mutation percentage is not a correctness guarantee.

## 9. CI, campaigns, and reproduction

Start with these **provisional campaign budgets**, then calibrate runtime. Budgets control cost, not confidence percentages. If a lane exceeds its budget, report the executed coverage and backlog rather than claiming the planned campaign ran.

| Lane | Initial target | Required outputs |
| --- | --- | --- |
| Every change | Existing regressions/types + saved scenarios + 200 generated cases per affected model, capped initially at 100 actions/case | Invariant results, seeds, coverage/reachability counts, failures |
| Protocol changes | Small finite TLC configurations and mandatory named interleavings | Model bounds, completion status, state count, violated property/counterexample |
| Pull request integration | Named real crash checkpoints for affected durable adapters; external-package fixture | Crash point/receipt/recovery matrix, platform |
| Nightly | Up to 10,000 generated cases/model, broader graph/depth bounds, up to 2 hours total | Executed counts, reached transitions/fault pairs, minimized failures |
| Nightly/weekly | Mutation checks and real-scheduler/repeated-lifecycle soak on Linux; periodic Darwin parity | Specific killed/surviving mutants; memory/resource trends |
| Release candidate | All saved corpus + advertised crash/OS matrix + repeated deterministic replay + longer real-process soak + matched benchmarks | Dated evidence bundle and unresolved limits |

Require every defined lifecycle transition and required fault/checkpoint pair to be reached by named tests even if random generation misses it. Add generated distribution statistics so a high test count cannot hide mostly rejected/no-op scenarios.

During qualification, replay selected interesting scenarios at least 20 times under the same build, including failure cases. Repeat lifecycle cycles with counts large enough to expose a memory trend; analyze post-warmup retained heap/resource counts and variation, not a single RSS sample. A long soak must assert ongoing useful progress, not merely that the process is alive.

Proposed commands, **not yet implemented**:

```sh
nix develop -c bun run core:verify       # bounded local regression/property suite
nix develop -c bun run core:model        # finite TLC models through pinned tooling
nix develop -c bun run core:simulate -- --seed 123 --cases 1000
nix develop -c bun run core:replay -- path/to/scenario.json
nix develop -c bun run core:crash        # real child-process/storage checks
nix develop -c bun run core:mutate       # semantic corpus + optional Stryker pilot
nix develop -c bun run core:soak -- --duration 30m
nix develop -c bun run core:compare      # matched comparative benchmarks
```

Existing commands remain `core:check`, `core:test`, and `core:bench`. Add new scripts only when their underlying checks exist. Use temporary directories for generated databases/fixtures and CI artifact storage for large histories. Linux-specific storage-fault tests do not silently substitute for Darwin verification, or vice versa.

## 10. Completion, sequencing, and deferred work

Suggested delivery slices are the numbered phases, not one enormous change. The critical path is:

```text
contract + verification foundation
  -> managed operations + evidence
  -> lifecycle hardening
  -> journal + real crash recovery
  -> reconstruction/inspection
  -> scoped composition + safe publication
  -> independent replacements + qualification
```

Performance baselines, adversarial testing, and semantic mutation checks run throughout. Interface design and tests come before broad migration. Estimate effort after Phase 0 and the two operation prototypes; avoid a calendar promise before the runtime/journal/simulation seams are validated.

**Definition of done for each slice:** implementation exists, public behavior is tested through its interface, at least one relevant fault is detected, regression replay works, affected documentation is current, and the requested behavior—not just code presence—is verified. An unrun OS lane, incomplete TLC exploration, blocked compatibility pilot, or missing external review is reported as such.

**Definition of done for the complete core:** all supported invariants have evidence; both durable adapters and alternate execution adapters pass conformance; all required semantic mutants are detected; the real-crash matrix and scoped replacement suite pass; external packaging works; an independent reader explains an execution; replay refuses unsafe/missing I/O; and comparative measurements document actual benefits and costs.

Deferred: profiles, agent-loop/tool/MCP/skill implementations, GUI work, marketplace/package installation, distributed consensus, transparent replay of arbitrary JS, arbitrary mid-call hot swapping, and untrusted-plugin isolation. They must not creep into the kernel to satisfy this plan.

## 11. Sources and research limits

1. [TigerBeetle VOPR documentation, pinned to 0.17.2](https://github.com/tigerbeetle/tigerbeetle/blob/0.17.2/docs/internals/vopr.md): real production code, substituted nondeterminism, seed/build replay, safety/liveness checkers.
2. [TigerBeetle: Protocol-Aware Deterministic Simulation Testing, 2026-08-20](https://tigerbeetle.com/blog/2026-08-20-protocol-aware-dst/): internal protocol invariants complement black-box guarantees.
3. [fast-check model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/) and [race-condition scheduling](https://fast-check.dev/docs/advanced/race-conditions/): commands, independent models, shrinking/replay, and wrapped-Promise scheduling limits. Website documentation evolves; use interfaces matching the pinned package version.
4. [Effect v3 TestClock](https://effect.website/docs/v3/testing/testclock): virtual time with the existing Effect runtime. Installed `effect/src/FastCheck.ts` supplies the public fast-check re-export.
5. [TLA+ tools](https://lamport.azurewebsites.net/tla/tools.html): TLC explicitly checks safety and liveness of executable specifications. This is distinct from verifying the TypeScript implementation.
6. [StrykerJS configuration](https://stryker-mutator.io/docs/stryker-js/configuration/#commandrunner-object), including its `testRunner` and `coverageAnalysis` sections: command execution is supported without per-test coverage optimization.
7. [Antithesis DST overview](https://antithesis.com/docs/resources/deterministic_simulation_testing/) and [setup requirements](https://antithesis.com/docs/setup/overview/): deterministic hypervisor alternative, hermetic Linux x86-64 images, external dependency packaging, registry/access requirements.
8. [DSH vendored framework changes, pinned snapshot](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/README.md): lifecycle hardening scenarios and non-transactional Loader updates.
9. [DSH persistence contract and conformance-test approach](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-persistence/README.md): behavioral backend substitution, explicit durability, crash outcomes, and reload limits.
10. [OpenTelemetry tracing SDK](https://opentelemetry.io/docs/specs/otel/trace/sdk/): sampling/export queues are not a lossless durable audit protocol.

This plan combines the prior Cordis investigation with primary-source testing-tool research and two local feasibility tests. TLC, Stryker/Bun, Antithesis, the proposed simulator, storage adapters, and comparative performance have **not** been implemented or evaluated by writing this plan. Recheck external tool compatibility when each phase begins. Maintain this document in place while it guides implementation; move settled usage/contracts into their authoritative documentation rather than retaining a parallel session log.
