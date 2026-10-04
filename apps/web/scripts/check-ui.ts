import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { createServer } from "vite";

/**
 * The web app's replaceability, checked on the real composition: the dev
 * server with the in-browser mock host (`?mock`), in Chromium. It holds the
 * invariant in apps/web/AGENTS.md at runtime, where `check-boundaries` holds
 * it in the imports:
 *
 * 1. The app boots without errors.
 * 2. Every part declared in `ui/contracts.ts` has a provider.
 * 3. Every plugin that is not pinned turns off and back on, as the Plugins
 *    page does it, and the page stays up and error-free either way.
 * 4. A part replaced by a lower-order item changes what renders, and the
 *    default returns when the replacement goes.
 * 5. A plugin's stylesheet leaves when it stops and returns once when it starts.
 * 6. What a plugin adds to the places the defaults use (header, sidebar and
 *    composer buttons, workspace bar, palette sources, inspector tabs) shows.
 *
 * Run it in the browser shell: `nix develop .#browser -c pnpm --filter @lemma/web ui:check`.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({ root, configFile: resolve(root, "vite.config.ts"), logLevel: "error", server: { port: 0, host: "127.0.0.1" } });
await server.listen();
const address = server.httpServer?.address();
assert(address !== null && typeof address === "object", "the dev server has no address");
const url = `http://127.0.0.1:${address.port}`;
const executablePath = process.env.LEMMA_CHROMIUM;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

const errors: string[] = [];
const expectNoErrors = (when: string) => {
  const found = errors.splice(0);
  assert.deepEqual(found, [], `errors ${when}`);
};
/** Resolves once the page has a frame drawn by whatever fills `root`. */
const settled = (page: Page) => page.waitForFunction(() => document.querySelector("#root")!.childElementCount > 0, undefined, { timeout: 10_000 });

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(`${url}/?mock`);
  await settled(page);
  await page.waitForFunction(() => "lemma" in window && (window as any).lemma.plugins.list().length > 0);
  expectNoErrors("while booting");

  // 2. Every declared part has a provider.
  const unfilled: string[] = await page.evaluate(async () => {
    const contracts = await import("/src/ui/contracts.ts" as string);
    const slots = (window as any).lemma.slots();
    return Object.values(contracts)
      .filter((value: any) => typeof value?.name === "string" && value.name.startsWith("part."))
      .filter((part: any) => slots.first(part) === undefined)
      .map((part: any) => part.name);
  });
  assert.deepEqual(unfilled, [], "parts nothing provides");

  // 3. Every plugin turns off and on, the way the Plugins page switches it; a locked one (pinned, or needed by one) stays on.
  const plugins: { id: string; locked: boolean }[] = await page.evaluate(() =>
    (window as any).lemma.plugins.list().map((plugin: any) => ({ id: plugin.id, locked: plugin.locked !== undefined })),
  );
  const switchTo = (id: string, enabled: boolean) =>
    page.evaluate(
      async ({ id, enabled }) => {
        const lemma = (window as any).lemma;
        const plugin = lemma.plugins.list().find((candidate: any) => candidate.id === id);
        await lemma.plugins.setEnabled(plugin, enabled);
        return lemma.plugins.list().find((candidate: any) => candidate.id === id).state;
      },
      { id, enabled },
    );
  const toggled: string[] = [];
  const locked: string[] = [];
  for (const { id, locked: isLocked } of plugins) {
    if (id === "client") continue;
    const stylesheets = () => page.evaluate((plugin) => document.head.querySelectorAll(`style[data-plugin="${plugin}"]`).length, id);
    const styled = await stylesheets();
    const stateOff = await switchTo(id, false);
    await settled(page);
    expectNoErrors(`turning ${id} off`);
    if (isLocked) {
      assert.equal(stateOff, "active", `${id} is locked but turned off`);
      locked.push(id);
    } else {
      assert.notEqual(stateOff, "active", `${id} did not turn off`);
      // Its styles leave with it, so nothing it drew styles a replacement.
      assert.equal(await stylesheets(), 0, `${id} left its stylesheet behind`);
    }
    await switchTo(id, true);
    await settled(page);
    expectNoErrors(`turning ${id} back on`);
    assert.equal(await stylesheets(), styled, `${id} came back with ${await stylesheets()} stylesheets, not ${styled}`);
    toggled.push(id);
  }
  const off = await page.evaluate(() =>
    (window as any).lemma.plugins
      .list()
      .filter((plugin: any) => plugin.state !== "active")
      .map((plugin: any) => plugin.id),
  );
  assert.deepEqual(off, [], "plugins not back on after the round trip");

  // 4. A replaced part renders instead of the default, everywhere, and the default returns.
  await page.fill("textarea", "hello");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".turn-footer", { timeout: 20_000 });
  assert((await page.locator(".turn .md").count()) > 0, "the default markdown part renders");
  await page.evaluate(async () => {
    const { MarkdownPart } = await import("/src/ui/contracts.ts" as string);
    const remove = (window as any).lemma.slots().add(MarkdownPart, {
      id: "check.markdown",
      order: 0,
      component: (props: { text: string }) => {
        const element = document.createElement("div");
        element.className = "replaced-markdown";
        element.textContent = props.text;
        return element;
      },
    });
    (window as any).removeReplacement = remove;
  });
  await page.waitForSelector(".replaced-markdown");
  assert.equal(await page.locator(".turn .md").count(), 0, "the default markdown part still renders beside its replacement");
  await page.evaluate(() => (window as any).removeReplacement());
  await page.waitForSelector(".turn .md");
  assert.equal(await page.locator(".replaced-markdown").count(), 0, "the replacement outlives its removal");
  expectNoErrors("replacing a part");

  // 6. What a plugin adds to the places the defaults use renders there: a marker in each.
  const marker = (slot: string, extra: Record<string, unknown> = {}) =>
    page.evaluate(
      async ({ slot, extra }) => {
        const contracts = await import("/src/ui/contracts.ts" as string);
        const component = () => {
          const element = document.createElement("span");
          element.className = `check-marker check-${slot}`;
          element.textContent = slot;
          return element;
        };
        const remove = (window as any).lemma.slots().add(contracts[slot], { id: `check.${slot}`, order: 1_000, component, ...extra });
        ((window as any).removals ??= []).push(remove);
      },
      { slot, extra },
    );
  await marker("ThreadHeader", { side: "end" });
  await marker("SidebarActions");
  await marker("ComposerActions");
  await marker("WorkspaceBarItems", { side: "start" });
  for (const slot of ["ThreadHeader", "SidebarActions", "ComposerActions", "WorkspaceBarItems"]) {
    await page.waitForSelector(`.check-${slot}`, { timeout: 5_000 }).catch(() => assert.fail(`${slot} does not render what a plugin adds`));
  }
  // A palette source: its items come up in the palette, and its prefix narrows to it.
  await page.evaluate(async () => {
    const { PaletteSources } = await import("/src/ui/contracts.ts" as string);
    const remove = (window as any).lemma.slots().add(PaletteSources, {
      id: "check.source",
      order: 1_000,
      label: "checks",
      heading: "Checks",
      prefix: "!",
      items: () => [{ key: "check:one", title: "Check item one", run: () => {} }],
    });
    ((window as any).removals ??= []).push(remove);
  });
  await page.keyboard.press("ControlOrMeta+k");
  await page.fill(".palette-input input", "!");
  await page.waitForSelector(".palette-row >> text=Check item one", { timeout: 5_000 }).catch(() => assert.fail("a palette source's items do not show"));
  // Escape clears the search, then closes.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".palette", { state: "detached" });
  // An inspector tab: it lists for the selected plugin.
  await page.evaluate(async () => {
    const { PluginTabs, Settings } = await import("/src/ui/contracts.ts" as string);
    const lemma = (window as any).lemma;
    const remove = lemma.slots().add(PluginTabs, { id: "check.tab", order: 1_000, label: () => "Checked", component: () => document.createElement("span") });
    ((window as any).removals ??= []).push(remove);
    (await lemma.service(Settings)).open("plugins");
  });
  await page.waitForSelector(".inspector-table [role=row] >> nth=1");
  await page.click(".inspector-table [role=row] >> nth=1");
  await page.waitForSelector(".inspector-tabs >> text=Checked", { timeout: 5_000 }).catch(() => assert.fail("an inspector tab does not show"));
  await page.evaluate(() => {
    for (const remove of (window as any).removals) remove();
  });
  await page.waitForFunction(() => document.querySelectorAll(".check-marker").length === 0);
  expectNoErrors("adding to the extension slots");

  console.log(
    `UI check: booted; every part provided; ${toggled.length - locked.length} plugins turned off and on, ${locked.length} locked ones kept on (${locked.join(", ")}); a part replaced and restored; six extension slots render what a plugin adds.`,
  );
} finally {
  await browser.close();
  await server.close();
}
