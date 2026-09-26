import { BrowserSocket } from "@effect/platform-browser";
import type { Effect, Layer, Scope } from "effect";
import { HostClient, layerHostClientWith, makeHostClientWith } from "./client.ts";
import type { HostClientOptions, HostClientService } from "./client.ts";

export * from "./index.ts";

export const makeHostClient = (options: HostClientOptions): Effect.Effect<HostClientService, never, Scope.Scope> =>
  makeHostClientWith(options, BrowserSocket.layerWebSocketConstructor);

export const layerHostClient = (options: HostClientOptions): Layer.Layer<HostClient> =>
  layerHostClientWith(options, BrowserSocket.layerWebSocketConstructor);
