# @basis/core

An Effect-native plugin runtime. The core knows about capabilities, hooks, events, config, and lifetimes—not agents, models, tools, sessions, or a UI. Application behavior belongs to plugins. The design and its rationale are in [docs/kernel.md](../../docs/kernel.md).

Only `effect` is a runtime dependency. Plugins are trusted, in-process TypeScript modules; there is no security sandbox.


## Use

```ts
import { Context, Effect, Layer } from "effect";
import { definePlugin, makeCore } from "@basis/core";

class Greeting extends Context.Tag("example/Greeting")<Greeting, string>() {}

const greeting = definePlugin({
  id: "greeting",
  provides: [Greeting],
  layer: Layer.succeed(Greeting, "Hello"),
});

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const core = yield* makeCore([greeting]);
  console.log(yield* core.run(Greeting));
})));
```

See [`examples/hello.ts`](examples/hello.ts) for a capability implementation extended by a separate plugin through its own hook. From the repository root:

```sh
nix develop -c bun install --frozen-lockfile
nix develop -c bun run packages/core/examples/hello.ts
nix develop -c bun run core:check
nix develop -c bun run core:test
nix develop -c bun run core:bench
```

The core pins its own Node declarations for Bun type compatibility rather than inheriting Electron's version. This is type-checking support, not a Node runtime requirement.

## Plugin contract

`definePlugin({ id, version?, config?, provides?, requires?, exclusive?, restart?, deadlines?, layer })` declares a composition member:

- `id` uniquely identifies an instance within one core. `version` is optional diagnostic metadata, not a dependency constraint.
- `config` is an Effect Schema. `makeCore(plugins, { configs })` decodes every plugin's config before any activation; an invalid or missing value is a `CompositionError` (`InvalidConfig`) naming the plugin and the failing path. `layer` may be a function of the decoded config.
- `exclusive` marks a plugin that cannot coexist with its replacement (a port, a lock); a reload stops it before starting the new instance. `restart` is an Effect `Schedule` consulted after a runtime failure; without one the plugin stays failed. `deadlines` bound activation and disposal (defaults 30s and 10s, overridable per core).
- Capabilities are ordinary Effect `Context.Tag`s. Share the tags between consumers and providers; use namespaced keys. Effect identifies capabilities by their keys.
- `provides` declares exports; `requires` declares dependencies supplied by other plugins. `PluginContext`, `Hooks`, and `Events` are available without declaration. The runtime rejects attempts to provide these built-ins or `Scope`.
- `layer` is an ordinary Effect `Layer`. Use `Layer.scoped`, `Effect.acquireRelease`, and `Effect.forkScoped` for resources and background work. Dependencies constructed privately inside a Layer need not be declared.
- The manifest is needed for runtime graph inspection and validation: Effect's type-level requirements alone cannot describe a dynamically supplied composition. Construction and cleanup still belong to Effect, not a second dependency-injection system.

The complete graph is validated before Layers execute. Missing dependencies, duplicate ids, competing providers, and cycles produce `CompositionError`. There is no implicit last-writer-wins override: replace a provider by supplying a different composition. Dependencies activate before consumers; independent plugins are ordered by code-unit id comparison. Activation receives only declared capabilities and the runtime context, not incidental capabilities from the host or unrelated plugins.

Each Layer's actual exports must exactly match `provides`. A mismatch, startup failure, defect, or deadline produces a `PluginFault` (phase `activate`) with the plugin id and original Effect cause. Pure interruption stays interruption. TypeScript checks declared inputs and outputs; runtime validation also covers untyped plugins.

Separate cores have independent capability environments and hook registrations, even when created from the same definitions. This is composition isolation, not isolation from shared module globals or operating-system access.

## Plugin-defined hooks

The core does not enumerate application extension points. A plugin exports a token such as:

```ts
const Render = Hook.make<string, string>("example/render");
```

Contributors obtain `PluginContext` and register around middleware:

```ts
const owner = yield* PluginContext;
yield* owner.on(Render, (input, next) =>
  Effect.map(next(input), (output) => output.toUpperCase()),
  { order: 10 },
);
```

The owning operation obtains `Hooks` and supplies its terminal behavior:

```ts
const hooks = yield* Hooks;
const result = yield* hooks.invoke(Render, "hello", Effect.succeed);
```

These snippets assume the exports are imported from `@basis/core`; the complete runnable example shows the wiring.

The hook contract is deliberately one mechanism: awaited, sequential around middleware. A handler can modify the input passed to `next`, wrap its result, or short-circuit by not calling it. Side-effect observers can call `next` and preserve the result. Plugins needing fan-out or streams can provide those capabilities using Effect; the core does not silently detach event listeners or create queues.

- Lower `order` runs first; ties use plugin id, then that plugin's registration order.
- A call snapshots its handler array. New registrations affect subsequent calls.
- Registration captures the plugin's dependency context, but **not its activation span**. The terminal retains its caller's dependencies. Trace ancestry follows the current invocation.
- A handler may execute `next` at most once, and only before the handler finishes. Await or join that work; do not detach continuations.
- Typed hook failures and defects propagate through the same Effect channels; interruption runs finalizers. `HookError` reports invalid ordering, token collisions, or continuation misuse.
- A name identifies one shared hook token within a core. Creating another token with the same name is rejected rather than risking an incompatible handler signature.
- Registrations are owned by the plugin scope and removed on disposal.

## Events

Hooks are for the critical path and fail closed. Events are the opposite: `Event.make<Payload>(name)` declares a fire-and-forget notification. `Events.publish` never fails and never waits for observers; `PluginContext.observe` subscribes with a bounded queue (default 64, `overflow: "dropOldest" | "dropNewest" | "suspend"`); an observer's failure becomes a `PluginFault` (phase `observe`) for its plugin and affects neither the publisher nor other observers. `Events.stream` subscribes from outside a plugin, for transports and tests. Use events only for information that is safe to lose; the session log, not the bus, is the source of truth.

## Supervision

`PluginContext.background(name, work, { required })` runs work owned by the plugin's scope and reports its exit. An optional task's failure is a `PluginFault` (phase `background`) and nothing else changes. A required task's failure fails the plugin: it and every plugin depending on it stop, in reverse order, while unrelated plugins keep running. Dependents are `closed` with `haltedBy` naming the root; the root is `failed` with its fault. Its capabilities disappear from `core.run`'s environment, so callers that still ask for them get Effect's missing-service defect.

Recovery is explicit: `core.restart(id)` reactivates the failed plugin and retries the dependents it halted. The named plugin must activate; a dependent that cannot is left failed, and its own dependents halted, without blocking the rest. A plugin with a `restart` schedule is retried automatically; the schedule persists across failures, so one that keeps failing exhausts it rather than restarting forever. An explicit restart resets it.

`core.faults` streams every fault as it happens; `core.inspect` keeps the latest per plugin.

## Loader and reload

`makeLoader({ source, composition })` runs a composition described by data: plugin ids mapped to `{ enabled?, config? }`, resolved to definitions by a `PluginSource` the host supplies. `loader.apply(next)` changes it at runtime:

1. Plan the whole target: resolve, decode config, validate the graph. Every problem is returned at once as `ReloadError.diagnostics`, each with a plugin id, config path where relevant, and a suggestion.
2. Only plugins whose definition or config changed, plus their dependents, are touched. Replacements start in a staging scope, hidden from dispatch, while the old instances keep serving.
3. Swap: new callers see the new environment, hooks, and observers in one step. Work already in flight finishes on the environment it entered with.
4. Old instances drain, then close in reverse order. Work that outlives the dispose deadline is interrupted and counted in `ReloadReport.interrupted`.

If any replacement fails to start, staged instances are disposed and the running composition is unchanged. `exclusive` plugins are the documented exception: they stop before the replacement starts, and if the replacement then fails they stay failed, attributed to that failure. Re-applying an unchanged composition does not restart a failed plugin; that takes `restart` or a config change.

## Lifetime and failure semantics

`makeCore` mounts a fixed composition as a scoped resource: the same runtime as the loader without `apply`.

`core.run(effect)` supplies capabilities while preserving unrelated caller requirements. Enter it around a task, not around every internal function call. Each entry uses an owned Effect fiber—not a new runtime—so both caller cancellation and core shutdown interrupt and await that work. Capability calls and hook dispatch inside it do not create an extra runtime or fiber per call.

Closing the owner scope stops new work, interrupts initialization and in-flight `core.run` tasks, then disposes plugins in reverse dependency order. Cleanup defects remain visible, and remaining finalizers still run. Failed or interrupted activation rolls back immediately, even when caught inside a longer-lived caller scope. Closing an already-closed core scope cannot reactivate it.

Cancellation and cleanup are cooperative. A stuck activation or finalizer is reported as a `PluginFault` with `deadline: true` once its limit passes; the core moves on and never claims a clean stop, but it cannot kill the work. Prefer `PluginContext.background` over raw `Effect.forkScoped` so failures are attributed. Detached fibers, raw timers, and other unmanaged work are outside these guarantees.

Rollback releases acquired resources and registrations. It cannot undo arbitrary external writes, network requests, or actions performed during module import. A retained capability value is also not revoked by magic: do not use capabilities outside their owner scope. `core.run` and hook dispatch reject use after closure.

## Inspection and tracing

`core.inspect` returns a detached snapshot of plugin identities, lifecycle state, latest fault, provided/required capability keys, ordered hook ownership, and event observers. It does not expose implementations or configuration secrets.

Activation, disposal, and each middleware execution emit native Effect spans with `plugin.id`, optional `plugin.version`, and hook name/order where applicable. `PluginContext.trace(name, effect)` attributes custom capability operations without proxying their implementations. Direct arbitrary function calls are not automatically intercepted. Install an Effect tracer around the host program to export spans; no telemetry destination is configured by the core.

These spans and composition snapshots are runtime provenance, **not a durable agent trajectory**. Persistence, domain events, payload redaction, and trajectory presentation belong to future plugins. Runtime-generated spans do not include hook arguments/results or plugin configuration.

## Performance checks

`core:bench` reports warm microbenchmarks for direct Effects, hook dispatch at several chain lengths (with tracing enabled/disabled), event publishing, `core.run` entry, mounting/disposing compositions, and reloading one plugin. It prints the runtime and machine and reports median/min/max **batch means**, not per-request latency percentiles. No external trace exporter is attached.

Dispatch reuses immutable, pre-ordered registration arrays; it does not resolve the plugin graph per call. No-listener dispatch avoids constructing a middleware environment. Lifecycle steps cost more than dispatch: each activation and disposal forks supervised fibers and waits under a deadline, which is measured in the mount and reload cases. The property test in `tests/sequences.test.ts` runs random load/reload/fail/restart sequences against a fault-injecting fixture and checks resource, registration, and dependency invariants after every step; set `BASIS_SEQUENCE_RUNS` to run more cases.

The benchmarks do not establish end-to-end agent performance, cold process startup, or sandbox overhead. Comparative numbers against cordis are planned but not yet measured. Those require their own workloads and measurements.
