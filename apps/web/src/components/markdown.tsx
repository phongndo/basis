import { createEffect } from "solid-js";
import { markdownBlocks } from "../lib/markdown.ts";

/** Copies the code of the block whose copy button was clicked. */
const copyCode = (event: MouseEvent): void => {
  const button = (event.target as HTMLElement | null)?.closest?.(".copy-code");
  if (!(button instanceof HTMLButtonElement)) return;
  const code = button.parentElement?.querySelector("code")?.textContent ?? "";
  void copyText(code).then((ok) => {
    button.textContent = ok ? "Copied" : "Failed";
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1200);
  });
};

/**
 * Sanitized markdown. Code blocks get a copy button. Blocks whose source is
 * unchanged keep their DOM, so a streaming message re-renders only its tail
 * and a selection in earlier text survives.
 */
export function Markdown(props: { text: string; class?: string }) {
  let el!: HTMLDivElement;
  let mounted: { readonly key: string; readonly nodes: readonly ChildNode[] }[] = [];
  createEffect(() => {
    const blocks = markdownBlocks(props.text);
    let same = 0;
    while (same < mounted.length && same < blocks.length && mounted[same]!.key === blocks[same]!.key) same++;
    for (const block of mounted.splice(same)) for (const node of block.nodes) node.remove();
    for (const block of blocks.slice(same)) {
      const template = document.createElement("template");
      template.innerHTML = block.html();
      for (const pre of template.content.querySelectorAll("pre")) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "copy-code";
        button.textContent = "Copy";
        button.setAttribute("aria-label", "Copy code");
        pre.append(button);
      }
      mounted.push({ key: block.key, nodes: [...template.content.childNodes] });
      el.append(template.content);
    }
  });
  return <div ref={el} class={`md ${props.class ?? ""}`} onClick={copyCode} />;
}

export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};
