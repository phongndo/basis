import { describe, expect, test } from "bun:test";
import { bashTool, OutputBuffer } from "../src/bash.ts";
import { call, context, textOf, withTempDir } from "./support.ts";

const bash = bashTool({ timeoutMs: 5_000, maxOutputChars: 30_000 });

describe("bash", () => {
  test("runs in the working directory and reports non-zero exit codes without isError", () => withTempDir(async (dir) => {
    const pwd = await call(bash, { command: "pwd" }, context(dir));
    expect(textOf(pwd)).toBe(await Bun.$`realpath ${dir}`.text().then((s) => s.trim()));
    expect(pwd.isError).toBeUndefined();
    expect(pwd.details).toMatchObject({ exitCode: 0, timedOut: false, truncated: false });
    const failing = await call(bash, { command: "echo oops; exit 3" }, context(dir));
    expect(textOf(failing)).toBe("oops\n\n[exit code 3]");
    expect(failing.isError).toBeUndefined();
    expect(failing.details).toMatchObject({ exitCode: 3 });
    expect(textOf(await call(bash, { command: "true" }, context(dir)))).toBe("(no output)");
  }));

  test("captures stderr alongside stdout", () => withTempDir(async (dir) => {
    const result = await call(bash, { command: "echo out; echo err >&2; echo out2" }, context(dir));
    const text = textOf(result);
    expect(text).toContain("out\n");
    expect(text).toContain("err");
    expect(text.indexOf("out")).toBeLessThan(text.indexOf("out2"));
  }));

  test("kills the process group on timeout", () => withTempDir(async (dir) => {
    const started = Date.now();
    const result = await call(bash, { command: "echo before; sleep 30; echo after", timeoutMs: 300 }, context(dir));
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("before");
    expect(textOf(result)).toContain("timed out after 300 ms");
    expect(result.details).toMatchObject({ timedOut: true });
  }), 10_000);

  test("does not wait for background children that keep the pipes open", () => withTempDir(async (dir) => {
    const started = Date.now();
    const result = await call(bash, { command: "sleep 3 & echo started" }, context(dir));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(textOf(result)).toBe("started");
    expect(result.details).toMatchObject({ exitCode: 0 });
  }));

  test("honors the abort signal by killing the process", () => withTempDir(async (dir) => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = call(bash, { command: "sleep 30" }, context(dir, controller.signal));
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("[command aborted]");
  }));

  test("keeps head and tail of long output", () => withTempDir(async (dir) => {
    const small = bashTool({ timeoutMs: 5_000, maxOutputChars: 200 });
    const result = await call(small, { command: "seq 1 5000" }, context(dir));
    const text = textOf(result);
    expect(text.startsWith("1\n2\n3\n")).toBe(true);
    expect(text.endsWith("4999\n5000")).toBe(true);
    expect(text).toMatch(/\[\.\.\. output truncated: \d+ characters omitted \.\.\.\]/);
    expect(result.details).toMatchObject({ truncated: true, exitCode: 0 });
  }));
});

describe("OutputBuffer", () => {
  test("passes short output through and bounds long output", () => {
    const short = new OutputBuffer(10);
    short.push("abc"); short.push("def");
    expect(short.render()).toBe("abcdef");
    expect(short.truncated).toBe(false);
    const long = new OutputBuffer(10);
    for (let i = 0; i < 20; i++) long.push(`${i % 10}`);
    expect(long.truncated).toBe(true);
    expect(long.total).toBe(20);
    expect(long.render()).toBe("012345\n\n[... output truncated: 10 characters omitted ...]\n\n6789");
    const bulk = new OutputBuffer(10);
    bulk.push("x".repeat(1000));
    expect(bulk.render()).toBe(`${"x".repeat(6)}\n\n[... output truncated: 990 characters omitted ...]\n\n${"x".repeat(4)}`);
  });
});
