/** macOS writes app shortcuts with ⌘; Windows and Linux with Ctrl. */
export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/**
 * Whether the platform's shortcut modifier is held: ⌘ on macOS, Ctrl elsewhere.
 * On macOS, Ctrl stays with text fields (Ctrl+K deletes to the end of the line).
 */
export const modKey = (event: KeyboardEvent): boolean => (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

const MAC: Readonly<Record<string, string>> = { mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃" };
const OTHER: Readonly<Record<string, string>> = { mod: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl" };

/** `shortcut("mod", "shift", "O")` as the platform writes it: ⌘⇧O, or Ctrl+Shift+O. */
export const shortcut = (...keys: string[]): string => (isMac ? keys.map((key) => MAC[key] ?? key).join("") : keys.map((key) => OTHER[key] ?? key).join("+"));

/** A binding such as `mod+shift+o`, `escape`, or `/`: its modifiers and key, lowercase. */
const parse = (binding: string) => {
  const parts = binding.toLowerCase().split("+");
  const key = parts.at(-1)!;
  return { key, mod: parts.includes("mod"), shift: parts.includes("shift"), alt: parts.includes("alt") };
};

const NAMES: Readonly<Record<string, string>> = { escape: "Esc", enter: "↵", arrowup: "↑", arrowdown: "↓" };

/** A binding as the platform writes it: `mod+shift+o` is ⌘⇧O or Ctrl+Shift+O. */
export const formatKeys = (binding: string): string => {
  const { key, mod, shift, alt } = parse(binding);
  return shortcut(...(mod ? ["mod"] : []), ...(shift ? ["shift"] : []), ...(alt ? ["alt"] : []), NAMES[key] ?? key.toUpperCase());
};

/**
 * Whether `event` presses `binding`. Shift must match for letters and when the
 * binding names it; for other keys it is whatever the layout needs to type
 * them (`/`, `?`).
 */
export const matchesKeys = (binding: string, event: KeyboardEvent): boolean => {
  const { key, mod, shift, alt } = parse(binding);
  if (event.key.toLowerCase() !== key || modKey(event) !== mod || event.altKey !== alt) return false;
  if (!mod && (event.ctrlKey || event.metaKey)) return false;
  return shift || /^[a-z]$/.test(key) ? event.shiftKey === shift : true;
};

/** A binding with no modifier types into a text field, so it waits until focus leaves one. */
export const bindsTyping = (binding: string): boolean => !parse(binding).mod;

/** Focus is in something that takes typing. */
export const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
