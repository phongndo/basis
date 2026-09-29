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
