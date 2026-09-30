import { describe, expect, it } from "vitest";
import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { bundledLanguages } from "shiki/langs";
import { bundledThemes } from "shiki/themes";
import { highlightTokens, loadLanguage } from "../src/lib/highlight.ts";

const code = ["const s = `multi", "line ${x}", "template`;", "/* comment", "still */ let y = 2;", "", "function f() {", "  return 'x';", "}", ""].join("\n");

const flat = (lines: ReturnType<typeof highlightTokens>) => lines?.map((line) => line.map((token) => [token.content, token.htmlStyle]));

describe("highlighting", () => {
  it("tokenizes streaming code like the whole code, at every step", async () => {
    expect(await loadLanguage("ts")).toBe(true);
    const reference = await createHighlighterCore({
      engine: createOnigurumaEngine(import("shiki/wasm")),
      themes: [bundledThemes["github-light"], bundledThemes["github-dark"]],
      langs: [bundledLanguages.ts],
    });
    const themes = { light: "github-light", dark: "github-dark" };
    for (const size of [1, 3, 11]) {
      for (let end = size; end < code.length + size; end += size) {
        const prefix = code.slice(0, Math.min(end, code.length));
        const streamed = flat(highlightTokens(prefix, "ts", false));
        const whole = flat(reference.codeToTokens(prefix, { lang: "ts", themes, defaultColor: false }).tokens);
        expect(streamed, JSON.stringify(prefix)).toEqual(whole);
      }
    }
  });

  it("leaves unknown languages plain", async () => {
    expect(await loadLanguage("not-a-language")).toBe(false);
    expect(highlightTokens("x", "not-a-language", true)).toBeUndefined();
  });
});
