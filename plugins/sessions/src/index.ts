import { Layer } from "effect";
import { definePlugin } from "@basis/core";
import { Paths, Sessions } from "@basis/contracts";
import { make } from "./sessions.ts";

export { Checkout, Header, decodeLine, encodeCwd, encodeLine, fileName } from "./format.ts";

export default definePlugin({
  id: "sessions",
  version: "0.1.0",
  provides: [Sessions],
  requires: [Paths],
  layer: Layer.scoped(Sessions, make),
});
