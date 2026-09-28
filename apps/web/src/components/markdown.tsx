import { createEffect } from "solid-js";
import { renderMarkdown } from "../lib/markdown.ts";

/** Sanitized markdown. Code blocks get a copy button (handled by a delegated listener in `copyCode`). */
export function Markdown(props: { text: string; class?: string }) {
  let el!: HTMLDivElement;
  createEffect(() => {
    el.innerHTML = renderMarkdown(props.text);
    for (const pre of el.querySelectorAll("pre")) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-code";
      button.textContent = "Copy";
      button.setAttribute("aria-label", "Copy code");
      pre.append(button);
    }
  });
  return <div ref={el} class={`md ${props.class ?? ""}`} />;
}

export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/** Install once: copies the code of the block whose button was clicked. */
export const installCodeCopy = (): void => {
  document.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest?.(".copy-code");
    if (!(button instanceof HTMLButtonElement)) return;
    const code = button.parentElement?.querySelector("code")?.textContent ?? "";
    void copyText(code).then((ok) => {
      button.textContent = ok ? "Copied" : "Failed";
      setTimeout(() => { button.textContent = "Copy"; }, 1200);
    });
  });
};
