import { describe, expect, test } from "bun:test";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { definePlugin, makeCore, PluginContext } from "@basis/core";
import { Agent, AgentError, AgentRequestHook, LlmRequest, Sessions, ToolError, ToolResult } from "@basis/contracts";
import type { Tool } from "@basis/contracts";
import agent, { buildRequest, CancelledEntry, NoticeEntry } from "../src/index.ts";
import {
  fakeLlm, fakeSessions, fakeTools, failing, hanging, okTool, recorder, scripted, stop, text, textOf, toolCalls, usage, user,
  waitFor,
} from "./fakes.ts";
import type { Script } from "./fakes.ts";

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect));

/** The agent over fakes; returns the composed core plus handles on the fakes. */
function harness(options: { scripts: readonly Script[]; tools?: readonly Tool<any>[]; config?: Record<string, unknown>; extra?: readonly ReturnType<typeof definePlugin>[] }) {
  const llm = fakeLlm(options.scripts);
  const tools = fakeTools(options.tools ?? []);
  const sessions = fakeSessions();
  const events = recorder();
  const core = makeCore([llm.plugin, tools.plugin, sessions.plugin, events.plugin, agent, ...(options.extra ?? [])], {
    configs: { agent: options.config ?? {} },
  });
  return Effect.map(core, (core) => ({ core, llm, tools, sessions, events }));
}

const contextOf = (sessionId: string) => Effect.flatMap(Sessions, (sessions) => sessions.context(sessionId));
const createSession = Effect.flatMap(Sessions, (sessions) => sessions.create("/work"));

describe("agent", () => {
  test("a text-only turn appends both messages, streams model events, and reports once", async () => {
    await run(Effect.gen(function* () {
      const { core, llm, events } = yield* harness({ scripts: [scripted(text("Hel"), text("lo"), usage(10, 2), stop("Hello"))] });
      const session = yield* core.run(createSession);
      yield* core.run(Effect.flatMap(Agent, (agent) => agent.prompt(session.id, user("hi"))));
      const context = yield* core.run(contextOf(session.id));
      expect(context.map((entry) => entry.payload)).toMatchObject([
        { type: "message", message: { role: "user" } },
        { type: "message", message: { role: "assistant", parts: [{ type: "text", text: "Hello" }] }, usage: { input: 10, output: 2 }, model: "anthropic/claude-opus-5" },
      ]);
      const request = llm.requests[0]!;
      expect(request.system).toContain("/work");
      expect(request.messages).toHaveLength(1);
      expect(request.tools).toBeUndefined();
      yield* waitFor(Effect.sync(() => events.ended.length), (n) => n === 1);
      expect(events.started).toHaveLength(1);
      expect(events.ended[0]).toMatchObject({ sessionId: session.id, turnId: events.started[0]!.turnId, reason: "done", usage: { input: 10, output: 2 } });
      expect(events.model.map((event) => event.type)).toEqual(["text-delta", "text-delta", "usage", "finish"]);
      expect(yield* core.run(Effect.flatMap(Agent, (agent) => agent.busy(session.id)))).toBe(false);
    }));
  });

  test("parallel tool calls run concurrently and a failing tool becomes an error result, not the end of the turn", async () => {
    await run(Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      // `slow` only finishes once `boom` has started, so a sequential loop would hang here.
      const slow: Tool<any> = { name: "slow", description: "waits", input: undefined as any, execute: () =>
        Deferred.await(gate).pipe(Effect.as(new ToolResult({ content: [{ type: "text", text: "slow done" }] }))) };
      const boom: Tool<any> = { name: "boom", description: "fails", input: undefined as any, execute: () =>
        Deferred.succeed(gate, undefined).pipe(Effect.zipRight(Effect.fail(new ToolError({ tool: "boom", reason: "Failed", message: "disk on fire" })))) };
      const { core, llm, tools } = yield* harness({
        scripts: [scripted(usage(5, 5), toolCalls({ id: "c1", name: "slow", input: {} }, { id: "c2", name: "boom", input: {} })), scripted(usage(7, 3), stop("done"))],
        tools: [slow, boom],
      });
      const session = yield* core.run(createSession);
      yield* core.run(Effect.flatMap(Agent, (agent) => agent.prompt(session.id, user("go")))).pipe(Effect.timeout(Duration.seconds(2)));
      expect(tools.executed.sort()).toEqual(["boom", "slow"]);
      const context = yield* core.run(contextOf(session.id));
      expect(context.map((entry) => entry.payload)).toMatchObject([
        { type: "message", message: { role: "user" } },
        { type: "message", message: { role: "assistant" } },
        { type: "message", message: { role: "user", parts: [
          { type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "slow done" }] },
          { type: "tool-result", toolCallId: "c2", content: [{ type: "text", text: "disk on fire" }], isError: true },
        ] } },
        { type: "message", message: { role: "assistant", parts: [{ type: "text", text: "done" }] } },
      ]);
      expect(llm.requests[1]!.messages).toHaveLength(3);
      expect(llm.requests[1]!.tools?.map((tool) => tool.name)).toEqual(["slow", "boom"]);
    }));
  });

  test("a multi-round loop sums usage across rounds and passes session cwd to tools", async () => {
    await run(Effect.gen(function* () {
      const cwds: string[] = [];
      const echo: Tool<any> = { name: "echo", description: "echo", input: undefined as any, execute: async (input, context) => {
        cwds.push(context.cwd);
        return new ToolResult({ content: [{ type: "text", text: String(input.n) }] });
      } };
      const { core, events } = yield* harness({
        scripts: [
          scripted(usage(10, 1), toolCalls({ id: "1", name: "echo", input: { n: 1 } })),
          scripted(usage(20, 2), toolCalls({ id: "2", name: "echo", input: { n: 2 } })),
          scripted(usage(30, 3), stop("finished")),
        ],
        tools: [echo],
      });
      const session = yield* core.run(createSession);
      yield* core.run(Effect.flatMap(Agent, (agent) => agent.prompt(session.id, user("count"))));
      expect(cwds).toEqual(["/work", "/work"]);
      const context = yield* core.run(contextOf(session.id));
      expect(context).toHaveLength(6);
      expect(textOf((context[5]!.payload as any).message)).toBe("finished");
      yield* waitFor(Effect.sync(() => events.ended.length), (n) => n === 1);
      expect(events.ended[0]!.usage).toMatchObject({ input: 60, output: 6 });
      expect(events.started).toHaveLength(1);
    }));
  });

  test("maxToolRounds stops the loop with error results for the pending calls and a visible note", async () => {
    await run(Effect.gen(function* () {
      const { core, llm, tools, events } = yield* harness({
        scripts: [
          scripted(toolCalls({ id: "1", name: "echo", input: {} })),
          scripted(toolCalls({ id: "2", name: "echo", input: {} })),
          scripted(stop("never reached")),
        ],
        tools: [okTool("echo", () => "ok")],
        config: { maxToolRounds: 1 },
      });
      const session = yield* core.run(createSession);
      yield* core.run(Effect.flatMap(Agent, (agent) => agent.prompt(session.id, user("loop"))));
      expect(tools.executed).toEqual(["echo"]);
      expect(llm.requests).toHaveLength(2);
      const context = yield* core.run(contextOf(session.id));
      expect(context.map((entry) => entry.payload)).toMatchObject([
        { type: "message" }, { type: "message" }, { type: "message" }, { type: "message" },
        { type: "message", message: { role: "user", parts: [{ type: "tool-result", toolCallId: "2", isError: true }] } },
        { type: "custom", kind: NoticeEntry, data: { message: expect.stringContaining("limit (1)") } },
      ]);
      yield* waitFor(Effect.sync(() => events.ended.length), (n) => n === 1);
      expect(events.ended[0]!.reason).toBe("done");
    }));
  });

  test("cancel mid-stream keeps the partial text, marks the turn, and ends with reason cancelled", async () => {
    await run(Effect.gen(function* () {
      const { core, events, sessions } = yield* harness({ scripts: [hanging(text("partial "), text("answer"))] });
      const session = yield* core.run(createSession);
      const turn = yield* Effect.fork(core.run(Effect.flatMap(Agent, (agent) => agent.prompt(session.id, user("hi")))));
      yield* waitFor(Effect.sync(() => events.model.length), (n) => n === 2);
      expect(yield* core.run(Effect.flatMap(Agent, (agent) => agent.busy(session.id)))).toBe(true);
      yield* core.run(Effect.flatMap(Agent, (agent) => agent.cancel(session.id)));
      const exit = yield* turn.await;
      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.isFailure(exit) && exit.cause).toMatchObject({ error: { _tag: "AgentError", reason: "Cancelled" } });
      expect(sessions.store.get(session.id)!.entries.map((entry) => entry.payload)).toMatchObject([
        { type: "message", message: { role: "user" } },
        { type: "message", message: { role: "assistant", parts: [{ type: "text", text: "partial answer" }] } },
        { type: "custom", kind: CancelledEntry, data: { partial: true } },
      ]);
      yield* waitFor(Effect.sync(() => events.ended.length), (n) => n === 1);
      expect(events.ended[0]!.reason).toBe("cancelled");
      expect(yield* core.run(Effect.flatMap(Agent, (agent) => agent.busy(session.id)))).toBe(false);
      // Cancelling an idle session is a no-op.
      yield* core.run(Effect.flatMap(Agent, (agent) => agent.cancel(session.id)));
    }));
  });

  test("a second prompt on a busy session fails with Busy and leaves the running turn alone", async () => {
    await run(Effect.gen(function* () {
      const { core, events } = yield* harness({ scripts: [hanging(text("...")), scripted(stop("other"))] });
      const session = yield* core.run(createSession);
      const other = yield* core.run(createSession);
      const first = yield* Effect.fork(core.run(Effect.flatMap(Agent, (agent) => agent.prompt(session.id, user("one")))));
      yield* waitFor(Effect.sync(() => events.started.length), (n) => n === 1);
      const second = yield* core.run(Effect.flatMap(Agent, (agent) => agent.prompt(session.id, user("two")))).pipe(Effect.either);
      expect(second._tag === "Left" && second.left).toMatchObject({ _tag: "AgentError", reason: "Busy", sessionId: session.id });
      // Other sessions are independent.
      yield* core.run(Effect.flatMap(Agent, (agent) => agent.prompt(other.id, user("three"))));
      expect(events.started).toHaveLength(2);
      yield* core.run(Effect.flatMap(Agent, (agent) => agent.cancel(session.id)));
      yield* first.await;
      yield* waitFor(Effect.sync(() => events.ended.length), (n) => n === 2);
      expect(events.ended.map((event) => event.reason).sort()).toEqual(["cancelled", "done"]);
    }));
  });

  test("AgentRequestHook handlers shape the request the model receives", async () => {
    await run(Effect.gen(function* () {
      const memory = definePlugin({
        id: "memory", layer: Layer.effectDiscard(Effect.gen(function* () {
          const owner = yield* PluginContext;
          yield* owner.on(AgentRequestHook, ({ sessionId, request }, next) =>
            next({ sessionId, request: new LlmRequest({ ...request, system: `${request.system}\n\nRemember: ${sessionId}` }) }));
        })),
      });
      const { core, llm } = yield* harness({ scripts: [scripted(stop("ok"))], extra: [memory], config: { systemPrompt: "Base." } });
      const session = yield* core.run(createSession);
      yield* core.run(Effect.flatMap(Agent, (agent) => agent.prompt(session.id, user("hi"))));
      expect(llm.requests[0]!.system).toBe(`Base.\n\nRemember: ${session.id}`);
    }));
  });

  test("an LlmError becomes AgentError Llm and the turn ends with reason error, once", async () => {
    await run(Effect.gen(function* () {
      const { core, events } = yield* harness({ scripts: [failing("provider down")] });
      const session = yield* core.run(createSession);
      const result = yield* core.run(Effect.flatMap(Agent, (agent) => agent.prompt(session.id, user("hi")))).pipe(Effect.either);
      expect(result._tag === "Left" && result.left).toMatchObject({ _tag: "AgentError", reason: "Llm", message: "provider down" });
      yield* waitFor(Effect.sync(() => events.ended.length), (n) => n === 1);
      expect(events.ended[0]!.reason).toBe("error");
      expect(events.started).toHaveLength(1);
      // The session is free again.
      expect(yield* core.run(Effect.flatMap(Agent, (agent) => agent.busy(session.id)))).toBe(false);
    }));
  });

  test("options and config choose model, effort, and tools; compaction becomes a summary exchange", async () => {
    await run(Effect.gen(function* () {
      const { core, llm } = yield* harness({
        scripts: [scripted(stop("a")), scripted(stop("b"))],
        tools: [okTool("read", () => ""), okTool("bash", () => ""), okTool("task", () => "")],
        config: { model: "openai/gpt-x", effort: "low" },
      });
      const session = yield* core.run(createSession);
      yield* core.run(Effect.flatMap(Sessions, (sessions) => sessions.append(session.id, { type: "message", message: user("old") })));
      yield* core.run(Effect.flatMap(Sessions, (sessions) => sessions.append(session.id, { type: "compaction", summary: "We discussed X.", tokensBefore: 1000 })));
      yield* core.run(Effect.flatMap(Agent, (agent) => agent.prompt(session.id, user("new"), { tools: ["read", "bash"] })));
      expect(llm.requests[0]).toMatchObject({ model: "openai/gpt-x", effort: "low" });
      expect(llm.requests[0]!.tools?.map((tool) => tool.name)).toEqual(["read", "bash"]);
      expect(llm.requests[0]!.messages.map((message) => [message.role, textOf(message)])).toEqual([
        ["user", "Summary of earlier conversation:\nWe discussed X."],
        ["assistant", "Understood. I will continue from that summary."],
        ["user", "new"],
      ]);
      yield* core.run(Effect.flatMap(Agent, (agent) => agent.prompt(session.id, user("again"), { model: "anthropic/claude-x", effort: "max" })));
      expect(llm.requests[1]).toMatchObject({ model: "anthropic/claude-x", effort: "max" });
      expect(llm.requests[1]!.tools).toHaveLength(3);
    }));
  });

  test("buildRequest previews the request the turn would send, hook included", async () => {
    await run(Effect.gen(function* () {
      const shaper = definePlugin({
        id: "shaper", layer: Layer.effectDiscard(Effect.gen(function* () {
          const owner = yield* PluginContext;
          yield* owner.on(AgentRequestHook, ({ sessionId, request }, next) => next({ sessionId, request: new LlmRequest({ ...request, maxTokens: 42 }) }));
        })),
      });
      const { core, llm } = yield* harness({ scripts: [scripted(stop("a"))], tools: [okTool("read", () => "")], extra: [shaper], config: { systemPrompt: "S" } });
      const session = yield* core.run(createSession);
      yield* core.run(Effect.flatMap(Sessions, (sessions) => sessions.append(session.id, { type: "message", message: user("hello") })));
      const preview = yield* core.run(buildRequest(session.id, undefined, { systemPrompt: "S" }));
      expect(preview).toMatchObject({ model: "anthropic/claude-opus-5", system: "S", maxTokens: 42 });
      expect(preview.messages.map(textOf)).toEqual(["hello"]);
      expect(preview.tools?.map((tool) => tool.name)).toEqual(["read"]);
      yield* core.run(Effect.flatMap(Agent, (agent) => agent.prompt(session.id, user("next"))));
      expect(llm.requests[0]).toMatchObject({ ...preview, messages: [...preview.messages, user("next")] });
      const missing = yield* core.run(buildRequest("nope")).pipe(Effect.either);
      expect(missing._tag === "Left" && missing.left).toMatchObject({ reason: "Session" });
    }));
  });

  test("a turn survives its caller and is cut short when the plugin scope closes", async () => {
    const sessions = fakeSessions();
    const events = recorder();
    const llm = fakeLlm([hanging(text("still going"))]);
    const scope = await Effect.runPromise(Scope.make());
    const core = await Effect.runPromise(makeCore([llm.plugin, fakeTools().plugin, sessions.plugin, events.plugin, agent], { configs: { agent: {} } }).pipe(Scope.extend(scope)));
    const session = await Effect.runPromise(core.run(createSession));
    const caller = await Effect.runPromise(Effect.forkDaemon(core.run(Effect.flatMap(Agent, (agent) => agent.prompt(session.id, user("hi"))))));
    await Effect.runPromise(waitFor(Effect.sync(() => events.model.length), (n) => n === 1));
    await Effect.runPromise(Fiber.interrupt(caller));
    expect(await Effect.runPromise(core.run(Effect.flatMap(Agent, (agent) => agent.busy(session.id))))).toBe(true);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(sessions.store.get(session.id)!.entries.map((entry) => entry.payload)).toMatchObject([
      { type: "message" }, { type: "message", message: { parts: [{ text: "still going" }] } }, { type: "custom", kind: CancelledEntry },
    ]);
  });
});
