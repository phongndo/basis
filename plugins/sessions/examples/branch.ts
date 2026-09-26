import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Effect, Layer, Stream } from "effect";
import { definePlugin, makeCore } from "@basis/core";
import { Message, Paths, Sessions } from "@basis/contracts";
import sessionsPlugin, { sessionPath } from "../src/index.ts";

// The host plugin normally provides Paths; here a temporary directory stands in.
const root = mkdtempSync(`${tmpdir()}/basis-sessions-example-`);
const paths = definePlugin({
  id: "paths", provides: [Paths],
  layer: Layer.succeed(Paths, { home: root, userConfig: "", projectConfig: "", auth: "", sessions: root, cwd: process.cwd() }),
});

const say = (role: "user" | "assistant", text: string) =>
  ({ type: "message" as const, message: new Message({ role, parts: [{ type: "text", text }] }) });

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const core = yield* makeCore([paths, sessionsPlugin]);
  yield* core.run(Effect.gen(function* () {
    const sessions = yield* Sessions;
    const info = yield* sessions.create(process.cwd());
    const a = yield* sessions.append(info.id, say("user", "Plan the feature"));
    yield* sessions.append(info.id, say("assistant", "Draft one"));
    yield* sessions.checkout(info.id, a.id);
    yield* sessions.append(info.id, say("assistant", "Draft two"));
    const view = yield* sessions.context(info.id);
    console.log("model view:", view.map((entry) => entry.payload.type === "message" ? entry.payload.message.parts : entry.payload.type));
    console.log("all entries:", (yield* Stream.runCollect(sessions.entries(info.id))).length);
    console.log("file:", sessionPath(root, process.cwd(), info.id));
  }));
})));
