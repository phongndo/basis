import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

/**
 * Compares two directories of screenshots from `scripts/shots.ts`: the share
 * of pixels that differ per screen, and a diff image (changes in red) for each
 * one that differs.
 *
 *   nix develop .#browser -c node scripts/compare-shots.ts /tmp/lemma-shots/before /tmp/lemma-shots/after
 */

const [before, after] = process.argv.slice(2).map((dir) => resolve(dir));
if (before === undefined || after === undefined) throw new Error("usage: compare-shots.ts <before> <after>");
const executablePath = process.env.LEMMA_CHROMIUM;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage();
const dataUrl = (path: string) => `data:image/png;base64,${readFileSync(path).toString("base64")}`;

let changed = 0;
try {
  for (const name of readdirSync(before)
    .filter((file) => file.endsWith(".png"))
    .sort()) {
    const result = await page.evaluate(
      async ({ a, b }) => {
        const load = (src: string) =>
          new Promise<HTMLImageElement>((done, fail) => {
            const image = new Image();
            image.onload = () => done(image);
            image.onerror = fail;
            image.src = src;
          });
        const [first, second] = await Promise.all([load(a), load(b)]);
        const width = Math.max(first.width, second.width);
        const height = Math.max(first.height, second.height);
        const pixels = (image: HTMLImageElement) => {
          const canvas = new OffscreenCanvas(width, height);
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, width, height).data;
        };
        const [p, q] = [pixels(first), pixels(second)];
        const diff = new OffscreenCanvas(width, height);
        const context = diff.getContext("2d")!;
        context.globalAlpha = 0.25;
        context.drawImage(second, 0, 0);
        context.globalAlpha = 1;
        const marks = context.getImageData(0, 0, width, height);
        let count = 0;
        for (let i = 0; i < p.length; i += 4) {
          if (Math.abs(p[i]! - q[i]!) + Math.abs(p[i + 1]! - q[i + 1]!) + Math.abs(p[i + 2]! - q[i + 2]!) <= 24) continue;
          count++;
          marks.data.set([230, 30, 30, 255], i);
        }
        context.putImageData(marks, 0, 0);
        const blob = await diff.convertToBlob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return { ratio: count / (width * height), sizeChanged: first.width !== second.width || first.height !== second.height, png: btoa(binary) };
      },
      { a: dataUrl(join(before, name)), b: dataUrl(join(after, name)) },
    );
    const percent = (result.ratio * 100).toFixed(2);
    if (result.ratio > 0 || result.sizeChanged) {
      changed++;
      writeFileSync(join(after, name.replace(/\.png$/, ".diff.png")), Buffer.from(result.png, "base64"));
    }
    console.log(`${result.ratio > 0 ? "≠" : "="} ${name.padEnd(36)} ${percent}%${result.sizeChanged ? " (size changed)" : ""}`);
  }
  console.log(changed === 0 ? "No differences." : `${changed} screens differ; diff images are beside them in ${after}.`);
} finally {
  await browser.close();
}
