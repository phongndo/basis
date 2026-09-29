// The host plugin is built by the app with a closure over its loader, so this
// package exports the factory rather than a ready plugin instance.
export { hostPlugin } from "./plugin.ts";
export type { HostControlService, HostPluginOptions } from "./plugin.ts";
export { PathsSchema, resolvePaths } from "./paths.ts";
export type { PathsService } from "./paths.ts";
export { HOST_PLUGIN_ID, isTrusted, loadComposition, parseConfig, patchConfig, projectPluginsDir, readConfigText, updateConfig } from "./config.ts";
export type { ConfigUpdate, LoadedComposition } from "./config.ts";
export { catalog, resolveComposition, withReplacements } from "./catalog.ts";
export type { CatalogInput, KnownPlugin, Resolved } from "./catalog.ts";
export { compositionInfo } from "./composition.ts";
export { watchConfig } from "./watch.ts";
export type { WatchOptions } from "./watch.ts";
