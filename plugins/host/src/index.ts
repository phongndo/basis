// The host plugin is built by the app with a closure over its loader, so this
// package exports the factory rather than a ready plugin instance.
export { hostPlugin } from "./plugin.ts";
export type { HostControlService, HostPluginOptions } from "./plugin.ts";
export { PathsSchema, resolvePaths } from "./paths.ts";
export type { PathsService } from "./paths.ts";
export { HOST_PLUGIN_ID, loadComposition } from "./config.ts";
export type { LoadedComposition } from "./config.ts";
export { watchConfig } from "./watch.ts";
export type { WatchOptions } from "./watch.ts";
