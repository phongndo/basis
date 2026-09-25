import { describe, expect, test } from "bun:test";
import { Effect, Exit, Scope } from "effect";
import { makeCore } from "@basis/core";
import { Agent, Sessions, ToolInvocation, Tools } from "@basis/contracts";
import agent, { CancelledEntry } from "@basis/plugin-agent";
import {
  fakeLlm, fakeSessions, fakeTools, hanging, okTool, recorder, scripted, stop, text, toolCalls, user, waitFor,
} from "../../agent/tests/fakes.ts";
import type { Script } from "../../agent/tests/fakes.ts";
import subagent, { finalAssistantText, TaskEntry } from "../src/index.ts";

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect));

/** Real agent and subagent over fake model, tools, and sessions. Scripts play in call order: parent, child, parent. */
function harness(scripts: readonly Script[]) {
  const llm = fakeLlm(scripts);
  const tools = fakeTools(["read", "bash", "edit", "write", "grep"].map((name) => okTool(name, () => name)));
  const sessions = fakeSessions();
  const events = recorder();
  return Effect.map(
    makeCore([llm.plugin, tools.plugin, sessions.plugin, events.plugin, agent, subagent], { configs: { agent: {} } }),
    (core) => ({ core, llm, tools, sessions, events }),
  );
}
const createSession = Effect.flatMap(Sessions, (sessions) => sessions.create("/work"));
const contextOf = (sessionId: string) => Effect.flatMap(Sessions, (sessions) => sessions.context(sessionId));

describe("subagent", () => {
  test("the task tool runs a child turn in a new session and returns its final text to the parent", async () => {
    await run(Effect.gen(function* () {
      const { core, llm, sessions } = yield* harness([
        scripted(toolCalls({ id: "t1", name: "task", input: { prompt: "Count the files.", model: "openai/small" } })),
        scripted(text("There are "), stop("There are 3 files.")),
        scripted(stop("Done: 3 files.")),
      ]);
      const parent = yield* core.run(createSession);
      yield* core.run(Effect.flatMap(Agent, (agent) => agent.prompt(parent.id, user("How many files?"))));

      const parentContext = yield* core.run(contextOf(parent.id));
      expect(parentContext.map((entry) => entry.payload)).toMatchObject([
        { type: "message", message: { role: "user" } },
        { type: "message", message: { role: "assistant", parts: [{ type: "tool-call", name: "task" }] } },
        { type: "message", message: { role: "user", parts: [{ type: "tool-result", toolCallId: "t1", content: [{ type: "text", text: "There are 3 files." }] }] } },
        { type: "message", message: { role: "assistant", parts: [{ type: "text", text: "Done: 3 files." }] } },
      ]);
      // The child is a separate session in the parent's cwd, linked back by its first entry.
      const child = [...sessions.store.values()].find((session) => session.info.id !== parent.id)!;
      expect(child.info.cwd).toBe("/work");
      expect(child.entries.map((entry) => entry.payload)).toMatchObject([
        { type: "custom", kind: TaskEntry, data: { parentSessionId: parent.id, toolCallId: "t1" } },
        { type: "message", message: { role: "user", parts: [{ type: "text", text: "Count the files." }] } },
        { type: "message", message: { role: "assistant" }, model: "openai/small" },
      ]);
      // The parent saw every tool including task; the child only the default set, never task.
      expect(llm.requests[0]!.tools?.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write", "grep", "task"]);
      expect(llm.requests[1]).toMatchObject({ model: "openai/small" });
      expect(llm.requests[1]!.tools?.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
      expect(llm.requests[1]!.messages.map((message) => message.role)).toEqual(["user"]);
    }));
  });

  test("an explicit tool list is honored minus task, and the result carries the child session id", async () => {
    await run(Effect.gen(function* () {
      const { core, llm } = yield* harness([scripted(stop("child says hi"))]);
      const parent = yield* core.run(createSession);
      const result = yield* core.run(Effect.flatMap(Tools, (tools) => tools.execute(new ToolInvocation({
        sessionId: parent.id, toolCallId: "x", name: "task", input: { prompt: "hi", tools: ["task", "grep"] }, cwd: "/elsewhere",
      }))));
      expect(result.content).toEqual([{ type: "text", text: "child says hi" }]);
      const childId = (result.details as { sessionId: string }).sessionId;
      expect(childId).not.toBe(parent.id);
      expect(yield* core.run(Effect.flatMap(Sessions, (sessions) => sessions.get(childId)))).toMatchObject({ cwd: "/elsewhere" });
      expect(llm.requests[0]!.tools?.map((tool) => tool.name)).toEqual(["grep"]);
    }));
  });

  test("a child that fails reports an error result to the parent instead of ending the parent turn", async () => {
    await run(Effect.gen(function* () {
      const { core } = yield* harness([
        scripted(toolCalls({ id: "t1", name: "task", input: { prompt: "explode" } })),
        scripted(), // child stream ends without a finish event
        scripted(stop("recovered")),
      ]);
      const parent = yield* core.run(createSession);
      yield* core.run(Effect.flatMap(Agent, (agent) => agent.prompt(parent.id, user("go"))));
      const context = yield* core.run(contextOf(parent.id));
      expect(context[2]!.payload).toMatchObject({ type: "message", message: { parts: [{ type: "tool-result", isError: true, content: [{ text: expect.stringContaining("finish") }] }] } });
      expect(context[3]!.payload).toMatchObject({ type: "message", message: { parts: [{ text: "recovered" }] } });
    }));
  });

  test("cancelling the parent turn cancels the child turn", async () => {
    await run(Effect.gen(function* () {
      const { core, events, sessions } = yield* harness([
        scripted(toolCalls({ id: "t1", name: "task", input: { prompt: "take your time" } })),
        hanging(text("child partial")),
      ]);
      const parent = yield* core.run(createSession);
      const turn = yield* Effect.fork(core.run(Effect.flatMap(Agent, (agent) => agent.prompt(parent.id, user("go")))));
      yield* waitFor(Effect.sync(() => events.model.filter((event) => event.type === "text-delta").length), (n) => n === 1);
      const child = [...sessions.store.values()].find((session) => session.info.id !== parent.id)!;
      expect(yield* core.run(Effect.flatMap(Agent, (agent) => agent.busy(child.info.id)))).toBe(true);

      yield* core.run(Effect.flatMap(Agent, (agent) => agent.cancel(parent.id)));
      const exit = yield* turn.await;
      expect(Exit.isFailure(exit) && exit.cause).toMatchObject({ error: { reason: "Cancelled" } });
      expect(yield* core.run(Effect.flatMap(Agent, (agent) => agent.busy(child.info.id)))).toBe(false);
      expect(child.entries.map((entry) => entry.payload)).toMatchObject([
        { type: "custom", kind: TaskEntry },
        { type: "message", message: { role: "user" } },
        { type: "message", message: { role: "assistant", parts: [{ text: "child partial" }] } },
        { type: "custom", kind: CancelledEntry },
      ]);
      yield* waitFor(Effect.sync(() => events.ended.length), (n) => n === 2);
      expect(events.ended.map((event) => [event.sessionId, event.reason]).sort()).toEqual([[parent.id, "cancelled"], [child.info.id, "cancelled"]].sort());
    }));
  });

  test("finalAssistantText takes the last assistant message's text", () => {
    const entries = [
      { payload: { type: "message", message: { role: "assistant", parts: [{ type: "text", text: "first" }] } } },
      { payload: { type: "message", message: { role: "user", parts: [{ type: "text", text: "then" }] } } },
      { payload: { type: "message", message: { role: "assistant", parts: [{ type: "thinking", text: "hmm" }, { type: "text", text: "a" }, { type: "text", text: "b" }] } } },
      { payload: { type: "custom", kind: "x", data: null } },
    ] as any;
    expect(finalAssistantText(entries)).toBe("ab");
    expect(finalAssistantText([])).toBe("");
  });
});
