import { describe, expect, test } from "bun:test";
import { Effect, Layer, Queue } from "effect";
import { Interaction, InteractionHook, Notice } from "@basis/contracts";
import type { InteractionAnswer, InteractionRequest } from "@basis/contracts";
import { definePlugin, makeCore, PluginContext } from "@basis/core";
import interaction from "../src/index.ts";

/** A UI stand-in: answers every request with the scripted function, recording what it saw. */
function answerer(answer: (request: InteractionRequest) => Effect.Effect<InteractionAnswer>) {
  const seen: InteractionRequest[] = [];
  const plugin = definePlugin({
    id: "ui",
    layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) =>
      owner.on(InteractionHook, (request) => { seen.push(request); return answer(request); }))),
  });
  return { plugin, seen };
}

const scripted = (request: InteractionRequest): Effect.Effect<InteractionAnswer> => {
  switch (request.type) {
    case "confirm": return Effect.succeed({ type: "confirm", value: true });
    case "ask": return Effect.succeed({ type: "ask", value: request.secret ? "sk-secret" : "plain" });
    case "select": return Effect.succeed({ type: "select", value: request.options[1]!.value });
    case "open-url": return Effect.succeed({ type: "open-url", value: request.expectCode ? "code-123" : "" });
  }
};

const run = <A, E>(plugins: Parameters<typeof makeCore>[0], configs: Record<string, unknown>, body: Effect.Effect<A, E, Interaction>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(makeCore(plugins, { configs }), (core) => core.run(body))));

describe("interaction", () => {
  test("routes each question through InteractionHook with a unique id and returns the typed answer", async () => {
    const ui = answerer(scripted);
    await run([interaction, ui.plugin], {}, Effect.gen(function* () {
      const ask = yield* Interaction;
      expect(yield* ask.confirm("Delete?", "Everything")).toBe(true);
      expect(yield* ask.ask("Key", { secret: true })).toBe("sk-secret");
      expect(yield* ask.ask("Name", { placeholder: "you" })).toBe("plain");
      expect(yield* ask.select("Model", [{ value: "a", label: "A" }, { value: "b", label: "B" }])).toBe("b");
      expect(yield* ask.openUrl("Sign in", "https://example.test/auth", { expectCode: true })).toBe("code-123");
      expect(yield* ask.openUrl("Sign in", "https://example.test/auth")).toBe("");
    }));
    expect(ui.seen.map((request) => request.type)).toEqual(["confirm", "ask", "ask", "select", "open-url", "open-url"]);
    expect(new Set(ui.seen.map((request) => request.id)).size).toBe(6);
    expect(ui.seen[0]).toMatchObject({ title: "Delete?", detail: "Everything" });
    expect(ui.seen[1]).toMatchObject({ title: "Key", secret: true });
    expect(ui.seen[2]).toMatchObject({ title: "Name", placeholder: "you" });
    expect(ui.seen[5]).toMatchObject({ url: "https://example.test/auth", expectCode: false });
  });

  test("fails Unavailable with no answerer", async () => {
    const error = await run([interaction], {}, Effect.flatMap(Interaction, (ask) => ask.confirm("Continue?")).pipe(Effect.flip));
    expect(error).toMatchObject({ _tag: "InteractionError", reason: "Unavailable" });
    expect(error.message).toContain("Continue?");
  });

  test("rejects an answer of the wrong type or an option that was not offered", async () => {
    const wrongType = answerer(() => Effect.succeed({ type: "ask", value: "yes" }));
    const mismatch = await run([interaction, wrongType.plugin], {}, Effect.flatMap(Interaction, (ask) => ask.confirm("Sure?")).pipe(Effect.flip));
    expect(mismatch).toMatchObject({ reason: "Unavailable" });
    expect(mismatch.message).toContain("confirm");

    const unknownOption = answerer(() => Effect.succeed({ type: "select", value: "z" }));
    const rejected = await run([interaction, unknownOption.plugin], {}, Effect.flatMap(Interaction, (ask) => ask.select("Pick", [{ value: "a", label: "A" }])).pipe(Effect.flip));
    expect(rejected).toMatchObject({ reason: "Unavailable" });
    expect(rejected.message).toContain('"z"');
  });

  test("times out a pending request when configured", async () => {
    const silent = answerer(() => Effect.never);
    const error = await run([interaction, silent.plugin], { interaction: { timeoutMs: 30 } },
      Effect.flatMap(Interaction, (ask) => ask.ask("Anyone?")).pipe(Effect.flip));
    expect(error).toMatchObject({ reason: "Timeout" });
    expect(error.message).toContain("Anyone?");
  });

  test("notify publishes a Notice event", async () => {
    const notices = await Effect.runPromise(Queue.unbounded<{ level: string; message: string }>());
    // An observer registered at activation is subscribed before the test body publishes.
    const log = definePlugin({
      id: "log",
      layer: Layer.effectDiscard(Effect.flatMap(PluginContext, (owner) => owner.observe(Notice, (notice) => Queue.offer(notices, notice)))),
    });
    await run([interaction, log], {}, Effect.gen(function* () {
      const ask = yield* Interaction;
      yield* ask.notify("Logged in");
      yield* ask.notify("Disk full", "error");
      expect([...(yield* Queue.takeN(notices, 2))]).toEqual([{ level: "info", message: "Logged in" }, { level: "error", message: "Disk full" }]);
    }));
  });
});
