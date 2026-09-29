import DOMPurify from "dompurify";
import { Marked } from "marked";

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

/**
 * Model markdown to sanitized HTML. Raw HTML in the source is sanitized, never
 * trusted. Styling attributes are dropped too: with `style`, `class`, or `id`
 * model output could position itself over the app or borrow the app's own
 * classes to fake a dialog or toast.
 */
export const renderMarkdown = (source: string): string => {
  hook();
  const html = marked.parse(source) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "style", "form", "input", "button", "textarea", "select"],
    FORBID_ATTR: ["style", "class", "id"],
  });
};
