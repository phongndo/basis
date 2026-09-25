import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { editTool } from "../src/edit.ts";
import { readTool } from "../src/read.ts";
import { writeTool } from "../src/write.ts";
import { call, context, textOf, withTempDir } from "./support.ts";

// 1x1 transparent PNG.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe("read", () => {
  test("numbers lines, resolves relative paths, and pages with offset and limit", () => withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "notes.txt"), "one\ntwo\nthree\nfour\n");
    const whole = await call(readTool, { path: "notes.txt" }, context(dir));
    expect(textOf(whole)).toBe("1|one\n2|two\n3|three\n4|four");
    expect(whole.isError).toBeUndefined();
    const page = await call(readTool, { path: "notes.txt", offset: 2, limit: 2 }, context(dir));
    expect(textOf(page)).toBe("2|two\n3|three\n\n[showing lines 2-3 of 4; use offset=4 to continue]");
    const past = await call(readTool, { path: "notes.txt", offset: 9 }, context(dir));
    expect(past.isError).toBe(true);
    expect(textOf(past)).toContain("past the end");
    await fs.writeFile(path.join(dir, "crlf.txt"), "a\r\nb\r\n");
    expect(textOf(await call(readTool, { path: "crlf.txt" }, context(dir)))).toBe("1|a\n2|b");
    await fs.writeFile(path.join(dir, "empty.txt"), "");
    expect(textOf(await call(readTool, { path: "empty.txt" }, context(dir)))).toBe("(empty file)");
  }));

  test("applies the default line limit", () => withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "big.txt"), Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n"));
    const result = textOf(await call(readTool, { path: "big.txt" }, context(dir)));
    expect(result.split("\n").length).toBe(2000 + 2);
    expect(result.endsWith("[showing lines 1-2000 of 2500; use offset=2001 to continue]")).toBe(true);
  }));

  test("returns images as base64 parts with their media type", () => withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "dot.PNG"), png);
    const result = await call(readTool, { path: path.join(dir, "dot.PNG") }, context("/"));
    expect(result.content).toEqual([{ type: "image", mediaType: "image/png", source: { kind: "base64", data: png.toString("base64") } }]);
  }));

  test("explains missing files and directories", () => withTempDir(async (dir) => {
    const missing = await call(readTool, { path: "nope.txt" }, context(dir));
    expect(missing).toMatchObject({ isError: true });
    expect(textOf(missing)).toBe(`File not found: ${path.join(dir, "nope.txt")}`);
    const directory = await call(readTool, { path: "." }, context(dir));
    expect(directory.isError).toBe(true);
    expect(textOf(directory)).toContain("is a directory");
  }));
});

describe("write", () => {
  test("creates parent directories and replaces content", () => withTempDir(async (dir) => {
    const target = path.join("deep", "er", "file.txt");
    const first = await call(writeTool, { path: target, content: "hello" }, context(dir));
    expect(textOf(first)).toBe(`Wrote 5 bytes to ${path.join(dir, target)}`);
    expect(await fs.readFile(path.join(dir, target), "utf8")).toBe("hello");
    await call(writeTool, { path: target, content: "héllo again" }, context(dir));
    expect(await fs.readFile(path.join(dir, target), "utf8")).toBe("héllo again");
  }));

  test("reports an unwritable path as an error result", () => withTempDir(async (dir) => {
    const result = await call(writeTool, { path: ".", content: "x" }, context(dir));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Cannot write");
  }));
});

describe("edit", () => {
  test("replaces exactly one occurrence and reports the line", () => withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "a.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const result = await call(editTool, { path: "a.ts", oldText: "const b = 2;", newText: "const b = 20;" }, context(dir));
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(`Edited ${path.join(dir, "a.ts")}: replaced 1 occurrence at line 2`);
    expect(await fs.readFile(path.join(dir, "a.ts"), "utf8")).toBe("const a = 1;\nconst b = 20;\nconst c = 3;\n");
  }));

  test("refuses missing and ambiguous matches without touching the file", () => withTempDir(async (dir) => {
    const original = "x = 1\ny = 1\n";
    await fs.writeFile(path.join(dir, "b.txt"), original);
    const missing = await call(editTool, { path: "b.txt", oldText: "z = 1", newText: "z = 2" }, context(dir));
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("was not found");
    const ambiguous = await call(editTool, { path: "b.txt", oldText: "= 1", newText: "= 2" }, context(dir));
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toContain("appears 2 times");
    const empty = await call(editTool, { path: "b.txt", oldText: "", newText: "q" }, context(dir));
    expect(empty.isError).toBe(true);
    expect(await fs.readFile(path.join(dir, "b.txt"), "utf8")).toBe(original);
    const absent = await call(editTool, { path: "nope.txt", oldText: "a", newText: "b" }, context(dir));
    expect(textOf(absent)).toContain("File not found");
  }));

  test("preserves CRLF line endings when the model writes LF", () => withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "win.txt"), "first\r\nsecond\r\nthird\r\n");
    const result = await call(editTool, { path: "win.txt", oldText: "second\nthird", newText: "2\n3\n4" }, context(dir));
    expect(result.isError).toBeUndefined();
    expect(await fs.readFile(path.join(dir, "win.txt"), "utf8")).toBe("first\r\n2\r\n3\r\n4\r\n");
  }));
});
