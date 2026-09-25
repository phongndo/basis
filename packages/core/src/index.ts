export { makeCore } from "./core.ts";
export type { Core, CoreOptions, CoreSnapshot, PluginSnapshot, PluginState } from "./core.ts";
export {
  ActivationError, CapabilityMismatch, CompositionError, CoreClosed, Diagnostic, FaultPhase, HookError,
  PluginFault, ReloadError,
} from "./errors.ts";
export { Event, Events } from "./events.ts";
export type { Observer, ObserveOptions } from "./events.ts";
export { Hook, Hooks, PluginContext } from "./hooks.ts";
export type { BackgroundOptions, Handler, HookOptions, Next, PluginIdentity } from "./hooks.ts";
export { makeLoader } from "./loader.ts";
export type { Composition, Loader, LoaderOptions, PluginEntry, PluginSource, ReloadReport } from "./loader.ts";
export { definePlugin } from "./plugin.ts";
export type { Capability, Deadlines, Plugin, PluginLayer } from "./plugin.ts";
