# Kernel design

The kernel (`packages/core`) composes plugins. It knows about capabilities, hooks, events, lifetimes, and configuration, not about agents, models, tools, sessions, or UIs. Everything a user sees is a plugin, shipped or third-party, using the same public interface.

**Status (2026-09-25):** the contracts below are defined in `packages/core/src` and type-checked. Behavior is implemented for composition validation, config decoding, activation, hooks, scoped disposal, and inspection. Events, background supervision, faults, deadlines, restart policy, and the loader are contracts only; calling them dies with a message pointing here.

## Principles

1. **Resolve once, at composition time.** Dependencies, config, and handler order are checked when a composition is planned. At call time a capability is a captured value and a hook with no handlers calls straight through. No proxies, no per-call graph walks, no meta-events.
2. **Typed dependencies.** A plugin declares `requires` and `provides` as Effect tags; the Layer's requirements must match at compile time, and actual exports are checked at activation. A missing dependency is a type error or a planning diagnostic, never a runtime lookup failure.
3. **Two extension primitives, with explicit failure rules.** *Hooks* (interceptors) wrap an operation and fail closed. *Events* notify and are isolated. See below.
4. **Failure domains.** A plugin that fails at runtime takes down itself and its dependents, nothing else. There is no automatic restart unless the plugin declares a `restart` schedule; the default is to stay `failed`, visibly, with a restart action in every UI.
5. **Transactional change.** A reload either fully applies or leaves the running composition untouched and returns every diagnostic at once.
6. **Everything has a limit.** Activation and disposal have deadlines; observer queues are bounded. Exceeding a limit is reported as a fault, never as a clean stop.
7. **Errors are data.** Effect's failure, defect, and interruption stay distinct to the edge. Anything that crosses a plugin boundary is attributed as a `PluginFault`; diagnostics are serializable and say what to do.
8. **Full permissions by default.** No approval service exists in the kernel or the shipped defaults. A gate is a user-authored hook handler on tool execution.

## Primitives

| Primitive | Declared by | Contract |
| --- | --- | --- |
| Capability | `Context.Tag` | A named, replaceable service. One provider per composition. |
| Plugin | `definePlugin` | Manifest (`id`, `config` schema, `provides`, `requires`, `exclusive`, `restart`, `deadlines`) plus a `Layer` that receives decoded config and owns resources through its `Scope`. |
| Hook | `Hook.make` | Around middleware on the critical path. Sequential, ordered, awaited. A handler may call `next` at most once. A handler failure fails the operation. |
| Event | `Event.make` | Fire-and-forget notification. `publish` never fails or waits. Observer failures become faults for their owner and affect nothing else. Bounded queue, default drop-oldest. |
| Background work | `PluginContext.background` | Supervised work owned by the plugin scope; its exit is reported. `required` work failing fails the plugin. |
| Loader | `makeLoader` | Runs a composition described by data (`Composition`) and changes it at runtime. |

**Rule for choosing hook versus event:** if the user must learn when it fails, it is a hook or a direct service call. Events carry only information that is safe to lose; the session log, not the event bus, is the source of truth, and a consumer that falls behind resyncs from it.

**Authoring surface.** The plugin skeleton is Effect. Shipped capability contracts (tools, commands, providers) accept plain async functions and wrap them once at registration, so most plugin code never touches Effect directly. Promise-based work cannot be interrupted mid-flight unless it checks its signal; Effect-based work can.

## Lifecycle

```
pending → activating → active → draining → closed
                ↘ failed ↗ (restart policy or explicit restart)
```

Plugins activate in dependency order and dispose in reverse. `draining` admits no new work while in-flight work finishes. Closing the owning scope interrupts initialization and in-flight `core.run` work, then disposes plugins. Cancellation is cooperative: a synchronous loop or a stuck finalizer is reported as a deadline fault, not killed.

## Reload

`Loader.apply(next)`:

1. Plan: resolve definitions, decode every config, validate the whole graph. Collect all diagnostics; on any error, stop here.
2. Compute the affected set: plugins whose definition or config changed, plus their dependents.
3. Start replacements in a staging scope while old instances keep serving. `exclusive` plugins (a port, a lock) are stopped first instead; that gap is explicit rather than pretending the swap was transactional.
4. Swap. Old instances drain, then close.
5. If any step fails, close the staging scope and return the failure. The running composition is unchanged.

The unit of reload is the plugin instance, not the operation: in-flight work finishes on the instance it started with.

## Faults and diagnostics

- `PluginFault { pluginId, phase, operation?, deadline?, cause }` is constructed by the core, never by plugins. Phases: `config`, `activate`, `service`, `intercept`, `observe`, `background`, `dispose`.
- `Diagnostic { severity, pluginId?, path?, message, suggestion? }` is a Schema class, so hosts and UIs receive the same structured value. Config problems carry the path into the config.
- `Core.faults` streams every fault in order; `Core.inspect` retains the latest fault per plugin.
- `ActivationError` and `CapabilityMismatch` predate `PluginFault` and will fold into it (phase `activate`) when the fault stream is implemented.

## Limits

Plugins are trusted, in-process code. Dependency visibility and scopes organize code; they are not a security boundary. Detached fibers, raw timers, and module-import side effects are outside the kernel's guarantees. Compositions supplied through the loader are validated when planned, so a loader-driven core is not statically typed (`Core<any>`).

## Outside the kernel

Shipped as plugins: LLM providers and credentials (wrapping `pi-ai`), tools, agent loop, sessions (JSONL tree), compaction, skills (`SKILL.md`), MCP, interaction (ask/confirm/select), transport (HTTP + WebSocket), UI, subagents.

Deferred, not planned for the kernel: remote capability proxies (designed after transport exists), per-session plugin subtrees (realms; sessions are data, and the one case that needs a different plugin set, subagents, is a plugin), untrusted-plugin isolation.

## Verification

Lifecycle edge cases, not dispatch, are where cordis needed most of its patches. The first investment is a fault-injecting fixture plugin plus fast-check sequences of load, reload, fail, cancel, and shutdown, checking that registrations never leak, closed plugins admit no work, cleanup never skips, and reloads never half-apply. Performance budgets cover cold start, the token streaming path, reload latency, and idle memory, measured against cordis in `core:bench`.
