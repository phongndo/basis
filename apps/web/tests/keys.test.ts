import { describe, expect, it, vi } from "vitest";
import { bindingOf, formatKeys, matchesKeys } from "../src/lib/keys.ts";

// Not a Mac here, so `mod` is Ctrl. Node has a `navigator` that reports the host, so pin it.
vi.hoisted(() => {
  Object.defineProperty(globalThis, "navigator", { value: { platform: "Linux x86_64", userAgent: "" }, configurable: true });
});

const press = (key: string, code: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) =>
  ({ key, code, ctrlKey: mods.ctrl ?? false, shiftKey: mods.shift ?? false, altKey: mods.alt ?? false, metaKey: mods.meta ?? false }) as KeyboardEvent;

describe("bindingOf", () => {
  it("records modifiers in a fixed order and letters by their physical key", () => {
    expect(bindingOf(press("K", "KeyK", { ctrl: true, shift: true }))).toBe("mod+shift+k");
    // Option+K types ˚ on a Mac; the binding is still k.
    expect(bindingOf(press("˚", "KeyK", { alt: true }))).toBe("alt+k");
    expect(bindingOf(press("ArrowDown", "ArrowDown", { ctrl: true, alt: true }))).toBe("mod+alt+arrowdown");
    expect(bindingOf(press(" ", "Space"))).toBe("space");
  });

  it("leaves shift out of symbols it types, and ignores modifiers alone", () => {
    expect(bindingOf(press("?", "Slash", { shift: true }))).toBe("?");
    expect(bindingOf(press("Shift", "ShiftLeft", { shift: true }))).toBeUndefined();
    expect(bindingOf(press("Control", "ControlLeft", { ctrl: true }))).toBeUndefined();
  });
});

describe("matchesKeys", () => {
  it("matches what bindingOf records", () => {
    for (const event of [
      press("K", "KeyK", { ctrl: true, shift: true }),
      press("˚", "KeyK", { alt: true }),
      press("?", "Slash", { shift: true }),
      press("ArrowUp", "ArrowUp", { ctrl: true, alt: true }),
      press("1", "Digit1", { ctrl: true }),
    ]) {
      expect(matchesKeys(bindingOf(event)!, event)).toBe(true);
    }
  });

  it("needs the exact modifiers", () => {
    expect(matchesKeys("mod+k", press("k", "KeyK", { ctrl: true, shift: true }))).toBe(false);
    expect(matchesKeys("mod+k", press("k", "KeyK"))).toBe(false);
    expect(matchesKeys("escape", press("Escape", "Escape"))).toBe(true);
  });
});

describe("formatKeys", () => {
  it("writes bindings the platform's way", () => {
    expect(formatKeys("mod+shift+o")).toBe("Ctrl+Shift+O");
    expect(formatKeys("mod+alt+arrowdown")).toBe("Ctrl+Alt+↓");
    expect(formatKeys("space")).toBe("Space");
  });
});
