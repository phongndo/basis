import DOMPurify from "dompurify";
import { Marked } from "marked";
import type { Token, TokensList } from "marked";

const marked = new Marked({ gfm: true, breaks: false, async: false });

let hooked = false;
const hook = () => {
  if (hooked) return;
  hooked = true;
  // No network fetches from model output (images are forbidden below); links open outside the app
  // and cannot reach back into it.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
};

const sanitize = (html: string): string =>
  DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "style", "form", "input", "button", "textarea", "select"],
    FORBID_ATTR: ["style", "class", "id"],
  });

/**
 * Model markdown to sanitized HTML. Raw HTML in the source is sanitized, never
 * trusted. Styling attributes are dropped too: with `style`, `class`, or `id`
 * model output could position itself over the app or borrow the app's own
 * classes to fake a dialog or toast.
 */
export const renderMarkdown = (source: string): string => {
  hook();
  return sanitize(marked.parse(source) as string);
};

export interface MarkdownBlock {
  /** Equal keys render equal HTML. */
  readonly key: string;
  readonly html: () => string;
}

/**
 * `source` as top-level blocks (paragraphs, lists, code blocks), each rendered
 * like `renderMarkdown`. A streaming message only grows at the end, so a view
 * that keeps the blocks whose key is unchanged re-renders just the last ones.
 * Reference-link definitions apply across blocks and are part of every key.
 */
export const markdownBlocks = (source: string): MarkdownBlock[] => {
  hook();
  const tokens = marked.lexer(source);
  const links = tokens.links;
  const definitions = JSON.stringify(links);
  return tokens.map((token: Token) => ({
    key: `${definitions}\u0000${token.raw}`,
    html: () => sanitize(marked.parser(Object.assign([token], { links }) as TokensList)),
  }));
};
