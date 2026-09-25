import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
import type { Scope } from "effect";
import { ToolInvocation, Tools } from "@basis/contracts";
import mcp, { matches, toToolResult } from "../src/index.ts";
import type { McpConfig } from "../src/index.ts";
import { mountAfterObservers, waitFor } from "./fakes.ts";
import type { Collected } from "./fakes.ts";

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect));
const FIXTURE = join(import.meta.dir, "fixtures", "server.ts");
const stdio = (name: string, options: { expose?: boolean; args?: string[]; command?: string } = {}) => ({
  name,
  transport: { type: "stdio" as const, command: options.command ?? process.execPath, args: options.command ? options.args ?? [] : [FIXTURE, ...(options.args ?? [])] },
  ...(options.expose === undefined ? {} : { expose: options.expose }),
});

const invocation = (name: string, input: unknown) => new ToolInvocation({ sessionId: "s", toolCallId: "c", name, input, cwd: "/" });

/** Mount, then wait until every configured server has reported once (connected or failed). */
const mount = (config: McpConfig, notices: Collected[]) => Effect.gen(function* () {
  const core = yield* mountAfterObservers(mcp, config, notices);
  const execute = (name: string, input: unknown) => core.run(Effect.flatMap(Tools, (t) => t.execute(invocation(name, input))));
  const text = (name: string, input: unknown) => Effect.map(execute(name, input), (result) => result.content.map((part) => part.type === "text" ? part.text : `<${part.type}>`).join("\n"));
  yield* waitFor(Effect.sync(() => notices), (n) => n.length >= config.servers.length);
  return { core, execute, text, list: core.run(Effect.flatMap(Tools, (t) => t.list)) };
});

describe("pure parts", () => {
  test("matches on the whole query or any word, case-insensitively", () => {
    const tool = { name: "read_file", description: "Read a File from disk", inputSchema: { type: "object" as const } };
    expect(matches("", tool)).toBe(true);
    expect(matches("READ_FILE", tool)).toBe(true);
    expect(matches("disk please", tool)).toBe(true);
    expect(matches("write", tool)).toBe(false);
  });

  test("maps MCP content to ToolResult parts", () => {
    const result = toToolResult({
      content: [
        { type: "text", text: "hi" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "audio", data: "AAAA", mimeType: "audio/wav" },
        { type: "resource", resource: { uri: "file:///a.txt", text: "body" } },
        { type: "resource_link", uri: "file:///b", name: "b" },
      ],
      isError: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "hi" },
      { type: "image", mediaType: "image/png", source: { kind: "base64", data: "AAAA" } },
      { type: "text", text: "[audio audio/wav, 4 base64 characters omitted]" },
      { type: "text", text: "[resource file:///a.txt]\nbody" },
      { type: "text", text: "[resource link file:///b: b]" },
    ]);
    const structured = toToolResult({ content: [], structuredContent: { n: 1 } });
    expect(structured.content).toEqual([{ type: "text", text: "{\n  \"n\": 1\n}" }]);
    expect(structured.details).toEqual({ structuredContent: { n: 1 } });
    expect(structured.isError).toBeUndefined();
  });
});

describe("search and call", () => {
  test("mcp_search lists every tool with its schema, filters by query and server; mcp_call maps results", async () => {
    const notices: Collected[] = [];
    await run(Effect.gen(function* () {
      const { execute, text, list } = yield* mount({ servers: [stdio("fix")] }, notices);
      expect(notices).toEqual([{ level: "info", source: "mcp", message: "MCP server \"fix\" connected with 5 tools" }]);
      expect((yield* list).map((t) => t.name).sort()).toEqual(["mcp_call", "mcp_search"]);

      const all = yield* text("mcp_search", {});
      for (const name of ["echo", "picture", "fail", "add_tool", "quit"]) expect(all).toContain(`tool: ${name}`);
      expect(all).toContain("\"text\":{\"type\":\"string\",\"description\":\"What to echo\"}");
      const filtered = yield* text("mcp_search", { query: "pixel image" });
      expect(filtered).toContain("tool: picture");
      expect(filtered).not.toContain("tool: echo");
      expect(yield* text("mcp_search", { query: "zzz" })).toBe("No matching MCP tools.");
      const wrongServer = yield* execute("mcp_search", { server: "other" });
      expect(wrongServer.isError).toBe(true);

      expect(yield* text("mcp_call", { server: "fix", tool: "echo", input: { text: "hi" } })).toBe("echo: hi");
      const picture = yield* execute("mcp_call", { server: "fix", tool: "picture" });
      expect(picture.content).toEqual([{ type: "text", text: "a pixel" }, { type: "image", mediaType: "image/png", source: { kind: "base64", data: expect.stringMatching(/^iVBOR/) } }]);
      const failed = yield* execute("mcp_call", { server: "fix", tool: "fail" });
      expect(failed).toMatchObject({ isError: true, content: [{ type: "text", text: "boom" }] });
      const unknownTool = yield* execute("mcp_call", { server: "fix", tool: "nope", input: {} });
      expect(unknownTool.isError).toBe(true);
      expect((unknownTool.content[0] as { text: string }).text).toContain("nope");
      const badInput = yield* execute("mcp_call", { server: "fix", tool: "echo", input: { text: 5 } });
      expect(badInput.isError).toBe(true);
      const unknownServer = yield* execute("mcp_call", { server: "other", tool: "echo" });
      expect(unknownServer).toMatchObject({ isError: true, content: [{ type: "text", text: "No MCP server named \"other\"." }] });
    }));
  });

  test("tools/list_changed refreshes the searchable list", async () => {
    const notices: Collected[] = [];
    await run(Effect.gen(function* () {
      const { text } = yield* mount({ servers: [stdio("fix")] }, notices);
      expect(yield* text("mcp_search", { query: "extra" })).toBe("No matching MCP tools.");
      expect(yield* text("mcp_call", { server: "fix", tool: "add_tool", input: { name: "extra" } })).toBe("added extra");
      const found = yield* waitFor(text("mcp_search", { query: "extra" }), (out) => out.includes("tool: extra"));
      expect(found).toContain("Dynamic tool extra");
      expect(yield* text("mcp_call", { server: "fix", tool: "extra", input: { value: 7 } })).toBe("extra: 7");
    }));
  });
});

describe("expose mode", () => {
  test("registers each server tool directly with the server's schema, and follows list changes", async () => {
    const notices: Collected[] = [];
    await run(Effect.gen(function* () {
      const { execute, text, list } = yield* mount({ servers: [stdio("fix", { expose: true }), stdio("plain")] }, notices);
      const names = (yield* list).map((t) => t.name).sort();
      expect(names).toEqual(["mcp__fix__add_tool", "mcp__fix__echo", "mcp__fix__fail", "mcp__fix__picture", "mcp__fix__quit", "mcp_call", "mcp_search"]);
      const echo = (yield* list).find((t) => t.name === "mcp__fix__echo")!;
      expect(echo.description).toBe("Echo the text back");
      expect(echo.inputSchema["properties"]).toEqual({ text: { type: "string", description: "What to echo" } });
      expect(echo.inputSchema["required"]).toEqual(["text"]);
      expect(yield* text("mcp__fix__echo", { text: "direct" })).toBe("echo: direct");
      const failed = yield* execute("mcp__fix__fail", {});
      expect(failed.isError).toBe(true);

      yield* execute("mcp__fix__add_tool", { name: "late" });
      yield* waitFor(list, (tools) => tools.some((t) => t.name === "mcp__fix__late"));
      expect(yield* text("mcp__fix__late", { value: 3 })).toBe("late: 3");
      expect((yield* list).filter((t) => t.name === "mcp__fix__echo")).toHaveLength(1);
    }));
  });
});

describe("failure isolation", () => {
  test("a server that cannot start leaves the plugin active, is reported once, and does not affect other servers", async () => {
    const notices: Collected[] = [];
    await run(Effect.gen(function* () {
      const { core, text, list } = yield* mount({ servers: [stdio("missing", { command: "/nonexistent/basis-mcp-fixture" }), stdio("crash", { args: ["--crash"] }), stdio("fix")] }, notices);
      yield* waitFor(Effect.sync(() => notices), (n) => n.length >= 3);
      const missing = notices.find((n) => n.message.includes("\"missing\""))!;
      expect(missing.level).toBe("error");
      expect(missing.message).toContain("failed to connect");
      const crash = notices.find((n) => n.message.includes("\"crash\""))!;
      expect(crash.level).toBe("error");
      expect(crash.message).toContain("fixture: refusing to start");
      expect(notices.find((n) => n.message.includes("\"fix\""))?.level).toBe("info");

      const snapshot = yield* core.inspect;
      expect(snapshot.plugins.find((p) => p.id === "mcp")?.state).toBe("active");
      expect((yield* list).map((t) => t.name).sort()).toEqual(["mcp_call", "mcp_search"]);
      const search = yield* text("mcp_search", {});
      expect(search).toContain("Server \"missing\" is failed:");
      expect(search).toContain("Server \"crash\" is failed:");
      expect(search).toContain("tool: echo");
      expect(yield* text("mcp_call", { server: "fix", tool: "echo", input: { text: "still fine" } })).toBe("echo: still fine");
      const down = yield* text("mcp_call", { server: "missing", tool: "echo", input: {} });
      expect(down).toContain("is not connected");
      // Only one notice per outage, however many retries happen.
      yield* Effect.sleep("1200 millis");
      expect(notices.filter((n) => n.message.includes("\"missing\""))).toHaveLength(1);
    }));
  });

  test("a server that exits is reported as disconnected and reconnects", async () => {
    const notices: Collected[] = [];
    await run(Effect.gen(function* () {
      const { text } = yield* mount({ servers: [stdio("fix")] }, notices);
      expect(yield* text("mcp_call", { server: "fix", tool: "quit" })).toBe("bye");
      yield* waitFor(Effect.sync(() => notices), (n) => n.some((notice) => notice.message.includes("disconnected")));
      const during = yield* waitFor(text("mcp_search", {}), (out) => out.includes("is failed") || out.includes("is connecting"));
      expect(during).not.toContain("tool: echo");
      yield* waitFor(Effect.sync(() => notices), (n) => n.filter((notice) => notice.message.includes("connected with")).length === 2);
      expect(yield* text("mcp_call", { server: "fix", tool: "echo", input: { text: "back" } })).toBe("echo: back");
    }));
  }, 10_000);
});
