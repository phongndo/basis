import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { trajectory } from "@basis/contracts";
import type { SessionEvent, SessionInfo } from "@basis/contracts";
import { ExitCode, run } from "../src/cli.ts";
import { formatSession, formatStep, formatTrajectory } from "../src/format.ts";

const hostMain = fileURLToPath(new URL("../../host/src/main.ts", import.meta.url));

const invoke = async (argv: readonly string[], home: string, cwd = "/") => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { env: { BASIS_HOME: home }, cwd, out: (text) => out.push(text), err: (text) => err.push(text) });
  return { code, out: out.join("\n"), err: err.join("\n") };
};

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
    for (const argv of [[], ["bogus"], ["status", "extra"], ["session", "show"], ["session", "list", "--all", "--cwd", "/x"], ["--nope"]]) {
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

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "basis-cli-"));
    await writeFile(join(home, "config.jsonc"), JSON.stringify({ plugins: { transport: { config: { port: 0 } } } }));
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

  test("session list is scoped to a directory unless --all", async () => {
    const list = await invoke(["session", "list"], home, home);
    expect(list).toMatchObject({ code: ExitCode.ok, out: `No sessions in ${home}.` });
    expect(JSON.parse((await invoke(["session", "list", "--all", "--json"], home)).out)).toEqual([]);
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

  test("a step names the plugin behind every part of the request", () => {
    const output = formatStep(turns[0]!, turns[0]!.steps[0]!);
    expect(output).toContain("  base from agent, 4 chars (changed)\n    BASE");
    expect(output).toContain("  project-context from project-context, 3 chars (changed)\n    CTX");
    expect(output).toMatch(/ {2}bash {2}from bash {2}\d+ chars {2}\(changed\)/);
    expect(output).toContain("composition  abc");
    expect(output).toMatch(/Tool runs:\n {2}bash {2}ok {2}300ms/);
  });
});
