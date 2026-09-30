import mermaid from "mermaid";

/*
 * Mermaid diagrams as images, imported on first use (the `diagrams` plugin
 * loads this module lazily). A diagram is model output, so it is shown as an
 * SVG `<img>`: an image cannot run script, load anything, or apply its styles
 * to the page, whatever the source says.
 */

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
const CACHE_MAX = 100;

/** Rendered diagrams by theme and source, so re-rendering a message (a draft settling) is instant. */
const cache = new Map<string, Promise<string>>();
/** Mermaid keeps global state while it renders; one at a time. */
let queue: Promise<unknown> = Promise.resolve();
let theme: string | undefined;
let count = 0;

/** The SVG with its drawn size as width and height, which an `<img>` needs (Mermaid sizes it by CSS instead). */
const sized = (svg: string): string => {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  const box = root
    .getAttribute("viewBox")
    ?.split(/[\s,]+/)
    .map(Number);
  if (box !== undefined && box.length === 4 && box.every(Number.isFinite)) {
    root.setAttribute("width", String(Math.ceil(box[2]!)));
    root.setAttribute("height", String(Math.ceil(box[3]!)));
    root.removeAttribute("style");
  }
  return new XMLSerializer().serializeToString(root);
};

const draw = async (code: string, dark: boolean): Promise<string> => {
  const wanted = dark ? "dark" : "default";
  if (theme !== wanted) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: wanted, htmlLabels: false, fontFamily: FONT });
    theme = wanted;
  }
  const started = performance.now();
  const { svg } = await mermaid.render(`lemma-mermaid-${++count}`, code);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized(svg))}`;
  // Shows in DevTools' performance panel, and to `performance.getEntriesByName("lemma:mermaid")`.
  performance.measure("lemma:mermaid", { start: started, detail: { chars: code.length } });
  return url;
};

/** `code` drawn as an SVG data URL in the light or dark theme; rejects with Mermaid's message when the source is invalid. */
export const renderDiagram = (code: string, dark: boolean): Promise<string> => {
  const key = `${dark ? "d" : "l"}\u0000${code}`;
  let result = cache.get(key);
  if (result === undefined) {
    result = queue.then(() => draw(code, dark));
    queue = result.catch(() => {});
    cache.set(key, result);
    result.catch(() => cache.delete(key));
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  return result;
};
