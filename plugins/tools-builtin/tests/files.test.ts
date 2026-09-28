import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editTool, readTool, writeTool } from "../src/index.ts";
import type { EditDetails, ReadDetails } from "../src/index.ts";
import { attempt, call, context, tempDir, textOf } from "./support.ts";

let dir: string;
beforeEach(async () => { dir = await tempDir(); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const put = (name: string, content: string | Buffer) => fs.writeFile(path.join(dir, name), content);
const get = (name: string) => fs.readFile(path.join(dir, name), "utf8");

describe("read", () => {
  it("returns text relative to cwd and pages with offset and limit", async () => {
    await put("a.txt", "one\ntwo\nthree\nfour\n");
    expect(textOf(await call(readTool, { path: "a.txt" }, context(dir)))).toBe("one\ntwo\nthree\nfour\n");
    expect(textOf(await call(readTool, { path: "@a.txt", offset: 2, limit: 2 }, context(dir))))
      .toBe("two\nthree\n\n[2 more lines in file. Use offset=4 to continue.]");
    expect(await attempt(readTool, { path: "a.txt", offset: 10 }, context(dir))).toBe("error: Offset 10 is beyond end of file (5 lines total)");
  });

  it("truncates to 2000 lines and 50KB with a continuation notice", async () => {
    await put("long.txt", Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n"));
    const long = await call(readTool, { path: "long.txt" }, context(dir));
    expect(textOf(long).split("\n").slice(-1)[0]).toBe("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
    expect((long.details as ReadDetails).truncation?.truncatedBy).toBe("lines");

    await put("wide.txt", Array.from({ length: 100 }, () => "x".repeat(1000)).join("\n"));
    expect(textOf(await call(readTool, { path: "wide.txt", offset: 3 }, context(dir))))
      .toMatch(/\[Showing lines 3-53 of 100 \(50\.0KB limit\)\. Use offset=54 to continue\.\]$/);

    await put("huge-line.txt", "y".repeat(60 * 1024));
    expect(textOf(await call(readTool, { path: "huge-line.txt" }, context(dir))))
      .toBe("[Line 1 is 60.0KB, exceeds 50.0KB limit. Use bash: sed -n '1p' huge-line.txt | head -c 51200]");
  });

  it("returns images by content, not extension, and reports missing files and directories", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
    await put("pic.dat", png);
    const image = await call(readTool, { path: "pic.dat" }, context(dir));
    expect(image.content).toEqual([
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", mimeType: "image/png", data: png.toString("base64") },
    ]);
    expect(await attempt(readTool, { path: "missing.txt" }, context(dir))).toBe("error: File not found: missing.txt");
    await fs.mkdir(path.join(dir, "sub"));
    expect(await attempt(readTool, { path: "sub" }, context(dir))).toContain("is a directory");
  });
});

describe("write", () => {
  it("creates parent directories and overwrites", async () => {
    const result = await call(writeTool, { path: "deep/er/file.txt", content: "héllo" }, context(dir));
    expect(textOf(result)).toBe("Successfully wrote 6 bytes to deep/er/file.txt");
    await call(writeTool, { path: "deep/er/file.txt", content: "bye" }, context(dir));
    expect(await get("deep/er/file.txt")).toBe("bye");
  });
});

describe("edit", () => {
  it("replaces unique text and returns a unified patch", async () => {
    await put("f.ts", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");
    const result = await call(editTool, { path: "f.ts", edits: [{ oldText: "b\n", newText: "B\n" }, { oldText: "i", newText: "I" }] }, context(dir));
    expect(textOf(result)).toBe("Successfully replaced 2 block(s) in f.ts.");
    expect(await get("f.ts")).toBe("a\nB\nc\nd\ne\nf\ng\nh\nI\nj\n");
    const details = result.details as EditDetails;
    expect(details.firstChangedLine).toBe(2);
    expect(details.patch).toBe([
      "--- f.ts", "+++ f.ts",
      "@@ -1,10 +1,10 @@", " a", "-b", "+B", " c", " d", " e", " f", " g", " h", "-i", "+I", " j", "",
    ].join("\n"));
  });

  it("refuses missing, ambiguous, overlapping, empty, and no-op edits without touching the file", async () => {
    await put("f.txt", "foo bar foo\nbaz\n");
    const tryEdit = (edits: unknown) => attempt(editTool, { path: "f.txt", edits }, context(dir));
    expect(await tryEdit([{ oldText: "nope", newText: "x" }])).toContain("Could not find the exact text in f.txt");
    expect(await tryEdit([{ oldText: "foo", newText: "x" }])).toContain("Found 2 occurrences of the text in f.txt");
    expect(await tryEdit([{ oldText: "bar foo", newText: "x" }, { oldText: "foo\nbaz", newText: "y" }])).toContain("edits[0] and edits[1] overlap");
    expect(await tryEdit([{ oldText: "", newText: "x" }])).toContain("oldText must not be empty");
    expect(await tryEdit([{ oldText: "baz", newText: "baz" }])).toContain("No changes made");
    expect(await tryEdit([{ oldText: "baz", newText: "q" }, { oldText: "zzz", newText: "q" }])).toContain("Could not find edits[1]");
    expect(await get("f.txt")).toBe("foo bar foo\nbaz\n");
  });

  it("counts overlapping occurrences as ambiguous", async () => {
    await put("f.txt", "}\n}\n}\n");
    expect(await attempt(editTool, { path: "f.txt", edits: [{ oldText: "}\n}\n", newText: "x" }] }, context(dir))).toContain("Found 2 occurrences of the text in f.txt");
    await put("g.txt", "aaaa");
    expect(await attempt(editTool, { path: "g.txt", edits: [{ oldText: "aa", newText: "b" }] }, context(dir))).toContain("Found 3 occurrences of the text in g.txt");
    expect(await get("f.txt")).toBe("}\n}\n}\n");
    expect(await get("g.txt")).toBe("aaaa");
  });

  it("accepts the legacy and stringified shapes models send", async () => {
    await put("f.txt", "one two three");
    await call(editTool, { path: "f.txt", oldText: "one", newText: "1" }, context(dir));
    await call(editTool, { path: "f.txt", edits: JSON.stringify([{ oldText: "two", newText: "2" }]) }, context(dir));
    await call(editTool, { path: "f.txt", edits: { oldText: "three", newText: "3" } }, context(dir));
    expect(await get("f.txt")).toBe("1 2 3");
  });

  it("matches LF text in CRLF files and preserves line endings and BOM", async () => {
    await put("win.txt", "﻿first\r\nsecond\r\nthird\r\n");
    await call(editTool, { path: "win.txt", edits: [{ oldText: "first\nsecond", newText: "1st\n2nd" }] }, context(dir));
    expect(await get("win.txt")).toBe("﻿1st\r\n2nd\r\nthird\r\n");
  });

  it("reports a missing file", async () => {
    expect(await attempt(editTool, { path: "none.txt", edits: [{ oldText: "a", newText: "b" }] }, context(dir))).toBe("error: Could not edit file: File not found: none.txt");
  });
});
