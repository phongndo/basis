export { makeCore } from "./core.ts";
export type { Core, CoreSnapshot, PluginSnapshot } from "./core.ts";
export { ActivationError, CapabilityMismatch, CompositionError, CoreClosed, HookError } from "./errors.ts";
export { Hook, Hooks, PluginContext } from "./hooks.ts";
export type { Handler, HookOptions, Next, PluginIdentity } from "./hooks.ts";
export { definePlugin } from "./plugin.ts";
export type { Capability, Plugin } from "./plugin.ts";
