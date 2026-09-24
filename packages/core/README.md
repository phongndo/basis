# @basis/core

An Effect-native plugin runtime. The core knows about capabilities, hooks, and lifetimes—not agents, models, tools, sessions, or a UI. Application behavior belongs to plugins.

Only `effect` is a runtime dependency. Plugins are trusted, in-process TypeScript modules supplied programmatically; there is no package loader or security sandbox.

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

`definePlugin({ id, version?, provides?, requires?, layer })` declares a composition member:

- `id` uniquely identifies an instance within one core. `version` is optional diagnostic metadata, not a dependency constraint.
- Capabilities are ordinary Effect `Context.Tag`s. Share the tags between consumers and providers; use namespaced keys. Effect identifies capabilities by their keys.
- `provides` declares exports; `requires` declares dependencies supplied by other plugins. `PluginContext` and `Hooks` are available without declaration. The runtime rejects attempts to provide these built-ins or `Scope`.
- `layer` is an ordinary Effect `Layer`. Use `Layer.scoped`, `Effect.acquireRelease`, and `Effect.forkScoped` for resources and background work. Dependencies constructed privately inside a Layer need not be declared.
- The manifest is needed for runtime graph inspection and validation: Effect's type-level requirements alone cannot describe a dynamically supplied composition. Construction and cleanup still belong to Effect, not a second dependency-injection system.

The complete graph is validated before Layers execute. Missing dependencies, duplicate ids, competing providers, and cycles produce `CompositionError`. There is no implicit last-writer-wins override: replace a provider by supplying a different composition. Dependencies activate before consumers; independent plugins are ordered by code-unit id comparison. Activation receives only declared capabilities and the runtime context, not incidental capabilities from the host or unrelated plugins.

Each Layer's actual exports must exactly match `provides`. A mismatch, startup failure, or defect produces `ActivationError` with the plugin id and original Effect cause. Pure interruption stays interruption. TypeScript checks declared inputs and outputs; runtime validation also covers untyped plugins.

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

## Lifetime and failure semantics

`makeCore` returns a scoped resource. Composition is fixed for that core's lifetime; there is no individual unload, hot replacement, or automatic restart.

`core.run(effect)` supplies capabilities while preserving unrelated caller requirements. Enter it around a task, not around every internal function call. Each entry uses an owned Effect fiber—not a new runtime—so both caller cancellation and core shutdown interrupt and await that work. Capability calls and hook dispatch inside it do not create an extra runtime or fiber per call.

Closing the owner scope stops new work, interrupts initialization and in-flight `core.run` tasks, then disposes plugins in reverse dependency order. Cleanup defects remain visible, and remaining finalizers still run. Failed or interrupted activation rolls back immediately, even when caught inside a longer-lived caller scope. Closing an already-closed core scope cannot reactivate it.

Cancellation and cleanup are cooperative. In-process synchronous loops, uninterruptible effects, or stuck finalizers can block shutdown; the core cannot safely kill them. Background tasks created by plugins are ordinary Effect fibers: keep them scoped and define their failure handling explicitly. The core does not automatically restart a failed background task. Detached fibers, raw timers, and other unmanaged work are outside these guarantees.

Rollback releases acquired resources and registrations. It cannot undo arbitrary external writes, network requests, or actions performed during module import. A retained capability value is also not revoked by magic: do not use capabilities outside their owner scope. `core.run` and hook dispatch reject use after closure.

## Inspection and tracing

`core.inspect` returns a detached snapshot of plugin identities, activation state, provided/required capability keys, and ordered hook ownership. It does not expose implementations or configuration secrets.

Activation, disposal, and each middleware execution emit native Effect spans with `plugin.id`, optional `plugin.version`, and hook name/order where applicable. `PluginContext.trace(name, effect)` attributes custom capability operations without proxying their implementations. Direct arbitrary function calls are not automatically intercepted. Install an Effect tracer around the host program to export spans; no telemetry destination is configured by the core.

These spans and composition snapshots are runtime provenance, **not a durable agent trajectory**. Persistence, domain events, payload redaction, and trajectory presentation belong to future plugins. Runtime-generated spans do not include hook arguments/results or plugin configuration.

## Performance checks

`core:bench` reports warm microbenchmarks for direct Effects, hook dispatch at several chain lengths (with tracing enabled/disabled), `core.run` entry, and mounting/disposing compositions. It prints the runtime and machine and reports median/min/max **batch means**, not per-request latency percentiles. No external trace exporter is attached.

Dispatch reuses immutable, pre-ordered registration arrays; it does not resolve the plugin graph per call. No-listener dispatch avoids constructing a middleware environment. The lifecycle tests also exercise repeated mounting and verify resource/registration cleanup; this is not a heap-leak proof.

The benchmarks do not establish end-to-end agent performance, cold process startup, sandbox overhead, or superiority over Cordis. Those require their own workloads and measurements.
