import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ledger, promptDiff, trajectory } from "@basis/contracts";
import type { SessionEvent, SessionInfo } from "@basis/contracts";
import { ExitCode, parseOffset, run } from "../src/cli.ts";
import { toAnswer } from "../src/live.ts";
import { formatDiff, formatRecords, formatSession, formatStep, formatSystem, formatTrajectory } from "../src/format.ts";

const hostMain = fileURLToPath(new URL("../../host/src/main.ts", import.meta.url));

const invoke = async (argv: readonly string[], home: string, cwd = "/") => {
  let out = "";
  const err: string[] = [];
  const code = await run(argv, {
    env: { BASIS_HOME: home }, cwd,
    out: (text) => { out += `${text}\n`; }, write: (text) => { out += text; }, err: (text) => err.push(text),
  });
  return { code, out: out.replace(/\n$/, ""), err: err.join("\n") };
};

const mockProvider = fileURLToPath(new URL("../../../scripts/fixtures/mock-openai.ts", import.meta.url));

const freePort = () => new Promise<number>((resolve) => {
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    server.close(() => resolve(port));
  });
});

describe("without a host", () => {
  let home: string;
  beforeAll(async () => { home = await mkdtemp(join(tmpdir(), "basis-cli-")); });
  afterAll(() => rm(home, { recursive: true, force: true }));

  test("reports a missing host as unavailable", async () => {
    const result = await invoke(["status", "--json"], home);
    expect(result.code).toBe(ExitCode.unavailable);
    expect(JSON.parse(result.err).error.code).toBe("NoHost");
  });

  test("rejects bad usage before connecting", async () => {
    for (const argv of [
      [], ["bogus"], ["status", "extra"], ["session", "show"], ["session", "list", "--all", "--cwd", "/x"], ["--nope"],
      ["inspect", "s", "--system"], ["inspect", "s", "--request", "1", "--system", "--diff"], ["inspect", "s", "--request", "1", "--records"],
      ["inspect", "s", "--request", "1", "--step", "2"], ["inspect", "s", "--sort", "bogus"], ["inspect", "s", "--range", "5"],
      ["run"], ["run", "s"], ["run", "s", "hi", "--thinking", "huge"], ["answer", "q"], ["login"], ["logout"], ["cancel"],
      ["workspace", "checkout"], ["workspace", "nope"], ["session", "title", "s"], ["session", "checkout", "s"], ["events", "x"],
      ["events", "--questions", "maybe"],
    ]) {
      expect((await invoke(argv, home)).code, argv.join(" ")).toBe(ExitCode.usage);
    }
  });

  test("prints help", async () => {
    const result = await invoke(["--help"], home);
    expect(result.code).toBe(ExitCode.ok);
    expect(result.out).toContain("session show <id>");
  });
});

describe("against a running host", () => {
  let home: string;
  let host: ChildProcess;
  let mock: ChildProcess;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "basis-cli-"));
    // A scripted provider: a prompt gets a bash call, the tool result gets a streamed answer.
    const port = await freePort();
    mock = spawn(process.execPath, [mockProvider], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve) => mock.stdout!.once("data", () => resolve()));
    await writeFile(join(home, "config.jsonc"), JSON.stringify({
      plugins: {
        transport: { config: { port: 0 } },
        llm: { config: { providers: [{ id: "mock", api: "openai-completions", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "scripted" }] }] } },
      },
    }));
    host = spawn(process.execPath, ["--conditions=source", hostMain, "--no-open"], {
      env: { ...process.env, BASIS_HOME: home, INIT_CWD: home }, stdio: "ignore",
    });
    const deadline = Date.now() + 20_000;
    while (!existsSync(join(home, "transport.json"))) {
      if (Date.now() > deadline || host.exitCode !== null) throw new Error("host did not start");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 30_000);

  afterAll(async () => {
    mock.kill();
    if (host.exitCode === null) {
      const exited = new Promise((resolve) => host.once("exit", resolve));
      host.kill("SIGTERM");
      await exited;
    }
    await rm(home, { recursive: true, force: true });
  });

  test("status reports the composition", async () => {
    const result = await invoke(["status", "--json"], home);
    expect(result.code).toBe(ExitCode.ok);
    const status = JSON.parse(result.out);
    expect(status.info.home).toBe(home);
    expect(status.plugins.map((plugin: { id: string }) => plugin.id)).toContain("agent");
    expect(status.plugins.every((plugin: { state: string }) => plugin.state === "active")).toBe(true);
    expect(status.running).toEqual([]);
  });

  test("run sends a prompt and prints the reply; --follow --json streams events and ends with the result", async () => {
    const session = (await invoke(["session", "new", "--cwd", home], home)).out;
    expect(await invoke(["session", "title", session, "CLI", "test"], home)).toMatchObject({ code: ExitCode.ok, out: `${session}  CLI test` });

    const plain = await invoke(["run", session, "check", "the", "shell", "--model", "mock/scripted"], home);
    expect(plain.code).toBe(ExitCode.ok);
    expect(plain.out).toContain("Everything works end to end.");
    expect(plain.out).toMatch(/── turn done · 2 steps · 1 tool call/);

    const followed = await invoke(["run", session, "again", "--model", "mock/scripted", "--follow", "--json"], home);
    const lines = followed.out.split("\n").map((line) => JSON.parse(line));
    expect(lines.some((event) => event.type === "turn-started")).toBe(true);
    expect(lines.some((event) => event.type === "delta" && event.event.type === "toolcall-end")).toBe(true);
    expect(lines.at(-1)).toMatchObject({ type: "result", session, reason: "done", steps: 2, toolCalls: 1 });

    const tools = JSON.parse((await invoke(["inspect", session, "--filter", "kind:tool", "--json"], home)).out);
    expect(tools.map((record: { tool: string; status: string }) => [record.tool, record.status])).toEqual([["bash", "ok"], ["bash", "ok"]]);
    expect(JSON.parse((await invoke(["inspect", session, "--records", "--sort", "duration", "--desc", "--json"], home)).out)[0].kind).toBe("assistant");
    expect((await invoke(["cancel", session], home)).code).toBe(ExitCode.ok);
  }, 30_000);

  test("lists providers, models, and open questions", async () => {
    expect(JSON.parse((await invoke(["models", "--json"], home)).out).map((model: { ref: string }) => model.ref)).toEqual(["mock/scripted"]);
    expect(JSON.parse((await invoke(["providers", "--json"], home)).out).some((provider: { id: string }) => provider.id === "mock")).toBe(true);
    expect(await invoke(["questions"], home)).toMatchObject({ code: ExitCode.ok, out: "No open questions." });
    expect((await invoke(["answer", "nope", "yes", "--json"], home)).code).toBe(ExitCode.failed);
  });

  test("session list is scoped to a directory unless --all", async () => {
    const empty = await mkdtemp(join(tmpdir(), "basis-cli-empty-"));
    try {
      expect(await invoke(["session", "list"], home, empty)).toMatchObject({ code: ExitCode.ok, out: `No sessions in ${empty}.` });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
    expect(JSON.parse((await invoke(["session", "list", "--all", "--json"], home)).out)).toBeInstanceOf(Array);
  });

  test("a domain error keeps the host's code", async () => {
    const result = await invoke(["session", "show", "missing", "--json"], home);
    expect(result.code).toBe(ExitCode.failed);
    expect(JSON.parse(result.err).error).toMatchObject({ code: "NotFound", subject: "missing" });
  });

  test("restart and reload go through the host", async () => {
    expect(JSON.parse((await invoke(["plugins", "restart", "project-context", "--json"], home)).out)).toEqual({ restarted: "project-context" });
    expect(await invoke(["reload"], home)).toMatchObject({ code: ExitCode.ok, out: "nothing changed" });
  });

  test("a rejected token fails instead of waiting", async () => {
    const other = await mkdtemp(join(tmpdir(), "basis-cli-"));
    try {
      const discovery = JSON.parse(await readFile(join(home, "transport.json"), "utf8"));
      await writeFile(join(other, "transport.json"), JSON.stringify({ ...discovery, token: "wrong" }));
      const result = await invoke(["status", "--json"], other);
      expect(result.code).toBe(ExitCode.unavailable);
      expect(JSON.parse(result.err).error.code).toBe("Unauthorized");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe("formatSession", () => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const event = (seq: number, data: SessionEvent["data"]): SessionEvent => ({ seq, id: `e${seq}`, parent: seq === 1 ? null : `e${seq - 1}`, at: 0, data });
  const info: SessionInfo = { id: "s1", cwd: "/work", createdAt: 0, updatedAt: 0, title: "Fix it", leaf: "e6", lastSeq: 6 };

  test("renders the branch as a transcript", () => {
    const output = formatSession(info, [
      event(1, { type: "turn-start", turnId: "t" }),
      event(2, { type: "message", message: { role: "user", content: [{ type: "text", text: "Fix it" }], timestamp: 0 } }),
      event(3, {
        type: "message",
        message: {
          role: "assistant", api: "x", provider: "p", model: "m", usage, stopReason: "toolUse", timestamp: 0,
          content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Looking." }, { type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } }],
        },
      }),
      event(4, {
        type: "message",
        message: { role: "toolResult", toolCallId: "c", toolName: "bash", isError: true, timestamp: 0, content: [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") }] },
      }),
      event(5, { type: "turn-end", turnId: "t", reason: "cancelled" }),
      event(6, { type: "title", title: "Fix it" }),
    ]);
    const body = output.slice(output.indexOf("\n\n") + 2);
    expect(body).toBe([
      "── user", "Fix it",
      "── assistant (p/m)", "Looking.", '→ bash {"command":"ls"}',
      "── bash (error)", ...Array.from({ length: 12 }, (_, i) => `line ${i}`), "… 8 more lines",
      "── turn ended: cancelled",
    ].join("\n"));
    expect(output).toContain("events   6 (6 on the current branch)");
  });
});

describe("inspect formatting", () => {
  const usage = { input: 1200, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 1240, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const spec = { name: "bash", description: "Run", parameters: {} };
  const events: SessionEvent[] = ([
    { type: "turn-start", turnId: "t" },
    { type: "message", turnId: "t", message: { role: "user", content: [{ type: "text", text: "Run ls" }], timestamp: 0 } },
    { type: "step-start", turnId: "t", stepId: "s1" },
    {
      type: "request", turnId: "t", stepId: "s1", model: "p/m", composition: "abc", system: "BASE\n\nCTX", tools: [spec],
      contributions: [
        { source: "agent", kind: "system", label: "base", chars: 4 },
        { source: "project-context", kind: "system", label: "project-context", chars: 3 },
        { source: "bash", kind: "tool", label: "bash", chars: JSON.stringify(spec).length },
      ],
    },
    {
      type: "message", turnId: "t", stepId: "s1", timing: { startedAt: 0, firstTokenAt: 500, endedAt: 2000 },
      message: { role: "assistant", api: "x", provider: "p", model: "m", usage, stopReason: "toolUse", timestamp: 0, content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command: "ls" } }] },
    },
    { type: "message", turnId: "t", stepId: "s1", timing: { startedAt: 2000, endedAt: 2300 }, message: { role: "toolResult", toolCallId: "c", toolName: "bash", content: [], isError: false, timestamp: 0 } },
    { type: "step-end", turnId: "t", stepId: "s1" },
    { type: "turn-end", turnId: "t", reason: "done" },
  ] satisfies SessionEvent["data"][]).map((data, i) => ({ seq: i + 1, id: `e${i + 1}`, parent: i === 0 ? null : `e${i}`, at: i * 1000, data }));
  const turns = trajectory(events);

  test("the overview has one line per step", () => {
    expect(formatTrajectory(turns)).toBe([
      "Turn 1 · done · 1 step · ↑1.2k ↓40 · 7.0s",
      '  "Run ls"',
      "  1  s1  m  1 msg  ↑1.2k ↓40  ttft 500ms  2.0s  → bash",
    ].join("\n"));
  });

  test("records list as a table with step, request, kind, status, time, tokens, and name", () => {
    expect(formatRecords(ledger(turns), false).split("\n")).toEqual([
      "step  req  kind    status    time   tokens   name",
      "1          user    sent                      Run ls",
      "1     #1   system  initial                   initial system prompt",
      "1.1   #1   model   tool use  2.0s   1.2k/40  → bash",
      '1.1        tool    ok        300ms           bash {"command":"ls"}',
    ]);
    expect(formatRecords([], false)).toBe("No records match.");
  });

  test("the system view prints each section under its plugin, and the diff view prints changed lines", () => {
    const request = turns[0]!.steps[0]!.request!;
    expect(formatSystem(request)).toBe("── base from agent, 4 chars (changed)\nBASE\n\n── project-context from project-context, 3 chars (changed)\nCTX");
    expect(formatDiff(promptDiff(undefined, request), true)).toContain("first request");
    const edited = { ...request, sections: request.sections.map((section) => (section.id === "base" ? { ...section, text: "BASE 2" } : section)) };
    expect(formatDiff(promptDiff(request, edited), false)).toBe("── base from agent (changed)\n- BASE\n+ BASE 2");
    expect(formatDiff([], false)).toContain("unchanged");
  });

  test("a step names the plugin behind every part of the request", () => {
    const output = formatStep(turns[0]!, turns[0]!.steps[0]!);
    expect(output).toContain("  base from agent, 4 chars (changed)\n    BASE");
    expect(output).toContain("  project-context from project-context, 3 chars (changed)\n    CTX");
    expect(output).toMatch(/ {2}bash {2}from bash {2}\d+ chars {2}\(changed\)/);
    expect(output).toContain("composition  abc");
    expect(output).toMatch(/Tool runs:\n {2}bash {2}ok {2}300ms/);
  });
});

describe("argument parsing", () => {
  test("offsets accept seconds, units, and combinations", () => {
    expect(parseOffset("90")).toBe(90_000);
    expect(parseOffset("1m30s")).toBe(90_000);
    expect(parseOffset("500ms")).toBe(500);
    expect(parseOffset("2h")).toBe(7_200_000);
    expect(parseOffset("soon")).toBeUndefined();
  });

  test("answers are checked against the question", () => {
    const select = { type: "select" as const, id: "q", title: "Pick", options: [{ value: "api_key", label: "API key" }, { value: "oauth", label: "Subscription" }] };
    expect(toAnswer(select, "oauth")).toEqual({ type: "select", value: "oauth" });
    expect(toAnswer(select, "api key")).toEqual({ type: "select", value: "api_key" });
    expect(toAnswer(select, "2")).toEqual({ type: "select", value: "oauth" });
    expect(toAnswer(select, "other")).toContain("Choose one of");
    expect(toAnswer({ type: "confirm", id: "c", title: "Go?" }, "Yes")).toEqual({ type: "confirm", value: true });
    expect(toAnswer({ type: "confirm", id: "c", title: "Go?" }, "maybe")).toContain("yes or no");
    expect(toAnswer({ type: "ask", id: "a", title: "Key" }, " sk ")).toEqual({ type: "ask", value: " sk " });
  });
});
