import type { Router } from "./router.ts";

export interface LinkOptions {
  /** Where links are listened for. Default `document`. */
  readonly root?: Document | HTMLElement;
  /** Same-origin paths that are not pages (a server's API): their links load as usual. */
  readonly ignore?: (url: URL) => boolean;
  /** A link to a page is about to be followed: hovered for `intentDelay`, or focused. Called once per link until it is left. */
  readonly onIntent?: (href: string) => void;
  /** How long the pointer rests on a link before that is intent, not passing over (ms). Default 50. */
  readonly intentDelay?: number;
}

/** The anchor an event happened in, if it is a link (shadow DOM included). */
const linkOf = (event: Event): HTMLAnchorElement | undefined =>
  event.composedPath().find((target): target is HTMLAnchorElement => (target as Element).tagName === "A" && (target as Element).hasAttribute?.("href"));

/** The app's own address a link names, or undefined when the browser should follow it as usual. */
const pageHref = (link: HTMLAnchorElement, options: LinkOptions): string | undefined => {
  if (link.hasAttribute("download") || (link.target !== "" && link.target !== "_self") || /\bexternal\b/.test(link.rel)) return undefined;
  const here = link.ownerDocument.location;
  const url = new URL(link.href, here.href);
  if (url.origin !== here.origin || options.ignore?.(url) === true) return undefined;
  // A link to a fragment of this page scrolls, as it would without the router.
  if (url.pathname === here.pathname && url.search === here.search && url.hash !== "") return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
};

/**
 * Plain clicks on links to the app's own pages navigate in place, so any
 * code links with an ordinary `<a href>`; a modified click (new tab), a
 * download, another target or origin, or `rel="external"` goes to the
 * browser. Hovering or focusing such a link reports the intent, to preload
 * what it shows. Returns the removal.
 */
export const interceptLinks = (router: Pick<Router, "navigate">, options: LinkOptions = {}): (() => void) => {
  const root = options.root ?? document;
  const onClick = (event: Event) => {
    const mouse = event as MouseEvent;
    if (mouse.defaultPrevented || mouse.button !== 0 || mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.altKey) return;
    const link = linkOf(event);
    const href = link === undefined ? undefined : pageHref(link, options);
    if (href === undefined) return;
    event.preventDefault();
    router.navigate(href);
  };
  let intended: HTMLAnchorElement | undefined;
  let resting: ReturnType<typeof setTimeout> | undefined;
  const onIntent = (event: Event) => {
    const link = linkOf(event);
    if (link === intended) return;
    intended = link;
    clearTimeout(resting);
    const href = link === undefined ? undefined : pageHref(link, options);
    if (href === undefined) return;
    if (event.type === "focusin") options.onIntent?.(href);
    else resting = setTimeout(() => options.onIntent?.(href), options.intentDelay ?? 50);
  };
  root.addEventListener("click", onClick);
  if (options.onIntent !== undefined) {
    root.addEventListener("pointerover", onIntent);
    root.addEventListener("focusin", onIntent);
  }
  return () => {
    clearTimeout(resting);
    root.removeEventListener("click", onClick);
    root.removeEventListener("pointerover", onIntent);
    root.removeEventListener("focusin", onIntent);
  };
};
