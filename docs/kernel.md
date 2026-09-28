# Kernel design

Basis (`packages/core`) is a domain-neutral TypeScript library for composing plugins.
It supplies capabilities, hooks, events, lifetimes, and configuration. The embedding
application chooses its domain contracts, plugin sources, and composition.

Usage details live in [the package README](../packages/core/README.md); this page
holds the rationale and constraints.

## Principles

1. **Resolve once, at composition time.** Dependencies, config, and handler order are checked when a composition is planned. At call time a capability is a captured value and a hook with no handlers calls straight through. No proxies, no per-call graph walks, no meta-events.
2. **Typed dependencies.** A plugin declares `requires` and `provides` as Effect tags; the Layer's requirements must match at compile time, and actual exports are checked at activation. Planning rejects missing dependencies. Runtime failures can revoke capabilities, so callers must still handle the resulting failure or interruption.
3. **Two extension primitives, with explicit failure rules.** *Hooks* (interceptors) wrap an operation and fail closed. *Events* notify and are isolated. See below.
4. **Failure domains.** A required background task failing stops its plugin and dependents while unrelated plugins keep running. Optional tasks and observers report faults without failing their plugin. There is no automatic restart unless the plugin declares a `restart` schedule, and that schedule persists across failures so a broken plugin can exhaust it. An explicit restart retries the named plugin and its halted dependents.
5. **Staged change.** Replacements activate before the old composition is swapped out. A staging failure preserves the old instances, except for exclusive resources, which require a documented interruption gap.
6. **Bounded waiting.** Activation, disposal, and the shutdown caller have cooperative deadlines. Event and diagnostic backlogs are bounded; stream delivery can lose entries. A lifecycle deadline is a fault, never a clean stop.
7. **Errors are data.** Effect's failure, defect, and interruption stay distinct. Lifecycle, observer, and background-work faults carry plugin attribution; hooks retain their error channel and tracing attribution. Ordinary capability functions are not automatically intercepted. Planning diagnostics are serializable and offer suggestions.
8. **Application-owned policy.** Plugins are trusted code with the process's permissions. Applications may implement policy through their own contracts and hooks. The kernel supplies no domain-specific approval service.

## Primitives

| Primitive | Declared by | Contract |
| --- | --- | --- |
| Capability | `Context.Tag` | A named, replaceable service. One provider per composition. |
| Plugin | `definePlugin` | Manifest (`id`, `config` schema, `provides`, `requires`, `exclusive`, `restart`, `deadlines`) plus a `Layer` that receives decoded config and owns resources through its `Scope`. |
| Hook | `Hook.make` | Around middleware on the critical path. Sequential, ordered, awaited. A handler may call `next` at most once. A handler failure fails the operation. |
| Event | `Event.make` | Notification with isolated observer failures. Bounded queue, default drop-oldest without waiting; explicit `suspend` applies backpressure. |
| Background work | `PluginContext.background` | Supervised work owned by the plugin scope; its exit is reported. `required` work failing fails the plugin. |
| Loader | `makeLoader` | Runs a composition described by data (`Composition`) and changes it at runtime. |

**Rule for choosing hook versus event:** if the caller must learn when it fails, use a hook or a direct capability call. Events carry only information that is safe to lose. Applications own authoritative state and recovery after missed notifications.

**Authoring surface.** The plugin skeleton uses Effect. Capability contracts are
ordinary TypeScript and can expose values, functions, promises, or Effects.
Applications decide which surface fits their operations. Effect supplies resource
ownership, structured concurrency, schemas, and cancellation; its role is broader
than runtime type checking. Promise-based work must honor a cancellation signal to
stop its underlying operation. No automatic wrapper can make arbitrary work cancelable.

**Runtime choice.** The framework remains TypeScript so plugin values, callbacks,
promises, and errors stay in the same runtime as its consumers. A native core would
require a second lifetime and value model across an FFI without a demonstrated
performance benefit. Node.js is the runtime for development, tests, and the harness
(including Electron's embedded Node); the library emits ESM JavaScript with
declarations and uses no runtime-specific APIs, so it also runs in browsers.
Workload measurements should guide any future native acceleration.

## Lifecycle

```
pending → activating → active → draining → closed
                ↘ failed ↗ (restart policy or explicit restart)
```

Plugins activate in dependency order and dispose in reverse. `draining` admits no new work while in-flight work finishes. Closing the owning scope interrupts initialization and in-flight `core.run` work, then disposes plugins. Cancellation is cooperative: a stuck asynchronous finalizer can be reported as a deadline fault, but a synchronous loop blocking the event loop also prevents the deadline timer from running. In-process code cannot be forcibly killed by this library.

Shutdown separates the caller's bounded wait from actual resource cleanup. After
a timeout the core remains `closing`; cleanup continues in dependency order and
retains resources that unfinished work may still use. It becomes `closed` only
after cleanup finishes. The [lifetime contract](../packages/core/README.md#lifetime-and-failure-semantics)
defines deadlines and observable failures. A stuck task has a core-level timeout,
without inventing a plugin owner.

## Reload

`Loader.apply(next)`:

1. Plan: resolve definitions, then decode configs and validate the whole graph. Collect diagnostics within each stage; on errors, stop before activation.
2. Compute the affected set: plugins whose definition or config changed, plus their dependents.
3. Start replacements in a staging scope while old instances keep serving. `exclusive` plugins (a port, a lock) are stopped first instead; that gap is explicit rather than pretending the swap was transactional.
4. Swap. Old instances drain, then close.
5. If staging fails, close the staging scope and return the failure. Old instances keep serving unless they were stopped for exclusive replacement; those can remain failed. After a successful swap, disposal faults are reported without undoing the new composition.

The unit of reload is the plugin instance, not the operation: in-flight work finishes on the instance it started with.

Unique registrations in a retained registry are exclusive resources too. A
contributor must release its registration during disposal before its replacement
can register the same name. Once a swap or exclusive interruption begins, the
supervised lifecycle operation completes even if its initiating caller is
interrupted. The owner scope still controls shutdown.

## Faults and diagnostics

- `PluginFault { pluginId, phase, operation?, deadline?, cause }` carries a framework-observed failure and its original Effect cause. Phases: `config`, `activate`, `service`, `intercept`, `observe`, `background`, `dispose`.
- `Diagnostic { severity, pluginId?, path?, message, suggestion? }` is a Schema class for structured composition diagnostics. Config problems carry the path into the config.
- `Core.faults` provides bounded, ordered live delivery with sequence gaps revealing loss; `Core.inspect` retains the latest fault of each current instance. See the [supervision contract](../packages/core/README.md#supervision) for capacity and ownership semantics.
- `CapabilityMismatch` and `DeadlineExceeded` appear as the cause inside a `PluginFault`, never on their own.
- Effect's timeout races cannot fire inside an uninterruptible region, and lifecycle bookkeeping is uninterruptible by design. Deadlines therefore wait on a daemon fiber plus a timer rather than `Effect.timeout`; on expiry, cleanup keeps running in the background and is reported, while a drain is abandoned and its stale work interrupted.

## Limits

Plugins are trusted, in-process code. Dependency visibility and scopes organize code; they are not a security boundary. Detached fibers, raw timers, and module-import side effects are outside the kernel's guarantees. Compositions supplied through the loader are validated when planned, so a loader-driven core is not statically typed (`Core<any>`).

## Outside the kernel

Application contracts, persistence, transports, user interfaces, package discovery,
configuration-file formats, and process bootstrap belong to consumers or their
plugins. An agent harness may supply agents, models, tools, and MCP; another
application may supply an entirely different domain. Neither defines the framework.

Basis does not require a daemon, a filesystem layout, a central contract catalog,
or an application registry. A `PluginSource` maps identifiers to definitions using
the embedding application's choices. Remote proxies and untrusted-code isolation
would need explicit designs and are outside the current library's guarantees.

## Verification

The property test (`packages/core/tests/sequences.test.ts`) drives a fault-injecting
fixture through random sequences of apply, background failure, restart, and fault
toggles. It checks resource ownership, registration lifetimes, dependency state,
rollback, and shutdown. Focused regressions cover lifecycle calls from owned work,
cancellation, deadlines, event closure, and exclusive registrations.

`package:check` installs a packed build in a temporary consumer, checks emitted
types, and exercises provider replacement and an actual HTTP listener on Node.js. `browser:check` also drives a DOM consumer in Chromium, checking hooks,
events, replacement, failure isolation, and listener cleanup through package exports.

`core:bench` measures framework costs; `core:stress` checks resource invariants and
measures startup, operation latency, and memory during lifecycle churn. The
[budget definitions](../packages/core/bench/budgets.ts) own the numerical limits
and reference environment. These synthetic workloads do not establish superiority
over another framework or production stability. CI checks deterministic contracts
and retains advisory performance results on scheduled/manual runs.
