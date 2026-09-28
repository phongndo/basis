import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { finish, record } from "../packages/core/bench/budgets.ts";

/** Runs the packed consumer in a real browser. The caller owns the temporary install. */
export async function checkBrowser(consumer: string) {
  const build = await Bun.build({ entrypoints: [join(consumer, "browser.ts")], target: "browser", minify: true });
  if (!build.success) throw new AggregateError(build.logs, "Browser consumer failed to bundle");
  const script = new Uint8Array(await build.outputs[0]!.arrayBuffer());
  const html = readFileSync(join(consumer, "browser.html"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    switch (new URL(request.url).pathname) {
      case "/": return new Response(html, { headers: { "content-type": "text/html" } });
      case "/browser.js": return new Response(script, { headers: { "content-type": "text/javascript" } });
      default: return new Response(null, { status: 204 });
    }
  } });
  const executablePath = process.env.BASIS_CHROMIUM ?? Bun.which("chromium") ?? undefined;
  try {
    const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => { errors.push(error.message); });
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      await page.goto(`http://127.0.0.1:${server.port}`);
      await page.waitForFunction(() => document.body.dataset.status !== undefined, undefined, { timeout: 10_000 });
      assert.equal(await page.getAttribute("body", "data-status"), "passed", await page.locator("output").innerText());
      assert.deepEqual(errors, []);
      console.log(`Browser consumer: DOM, hooks, events, replacement, failure isolation, and cleanup passed (${browser.version()}).`);
      record("browserBundleBytes", script.byteLength);
      record("browserBundleGzipBytes", gzipSync(script).byteLength);
      finish("browser");
    } finally { await browser.close(); }
  } finally { server.stop(true); }
}
