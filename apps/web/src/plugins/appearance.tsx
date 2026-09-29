import { createEffect, createSignal } from "solid-js";
import { load, save } from "../lib/storage.ts";
import { PaletteIcon } from "../components/icons.tsx";
import { Segmented, SettingRow } from "../components/setting-row.tsx";
import { SettingsGroups, SettingsSections, Slots } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

type Theme = "system" | "light" | "dark";
/** How wide the conversation runs. */
type ContentWidth = "default" | "wide" | "full";

const THEME_KEY = "lemma.theme";
const WIDTH_KEY = "lemma.contentWidth";
const THEMES: readonly { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
const WIDTHS: readonly { value: ContentWidth; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full" },
];
const CONTENT_WIDTHS: Record<ContentWidth, string | undefined> = { default: undefined, wide: "1040px", full: "none" };

const storedTheme = () => (load(THEME_KEY) as Theme | undefined) ?? "system";
const storedWidth = () => (load(WIDTH_KEY) as ContentWidth | undefined) ?? "default";
const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

const applyTheme = (theme: Theme, prefersDark: boolean) => {
  document.documentElement.dataset.theme = theme === "system" ? (prefersDark ? "dark" : "light") : theme;
};
const applyWidth = (width: ContentWidth) => {
  const value = CONTENT_WIDTHS[width];
  if (value === undefined) document.documentElement.style.removeProperty("--content");
  else document.documentElement.style.setProperty("--content", value);
};

/** Applies the remembered appearance before the plugins start, so a dark theme does not flash light while the page boots. */
export const preloadAppearance = (): void => {
  applyTheme(storedTheme(), darkQuery().matches);
  applyWidth(storedWidth());
};

/**
 * Theme and conversation width, remembered in this browser and applied to
 * the document as `data-theme` and `--content`. Stylesheets in `~/.lemma/ui`
 * override any other `--` token.
 */
export default defineUiPlugin({
  id: "appearance",
  requires: { slots: Slots },
  setup: ({ slots }, plugin) => {
    const [theme, setTheme] = createSignal(storedTheme());
    const [width, setWidth] = createSignal(storedWidth());
    const dark = darkQuery();
    const [prefersDark, setPrefersDark] = createSignal(dark.matches);
    const onScheme = () => setPrefersDark(dark.matches);
    dark.addEventListener("change", onScheme);
    plugin.onCleanup(() => dark.removeEventListener("change", onScheme));
    createEffect(() => applyTheme(theme(), prefersDark()));
    // Left applied when the plugin stops: a replacement starts before the old instance stops, and has already applied its own.
    createEffect(() => applyWidth(width()));

    plugin.onCleanup(slots.add(SettingsSections, { id: "appearance", order: 10, title: "Appearance", icon: PaletteIcon }));
    plugin.onCleanup(
      slots.add(SettingsGroups, {
        id: "appearance",
        section: "appearance",
        entries: () => [
          {
            text: "Theme color scheme dark light system mode",
            view: () => (
              <SettingRow title="Theme" description="System follows your browser or OS setting.">
                <Segmented
                  label="Theme"
                  value={theme()}
                  options={THEMES}
                  onChange={(next) => {
                    save(THEME_KEY, next === "system" ? undefined : next);
                    setTheme(next);
                  }}
                />
              </SettingRow>
            ),
          },
          {
            text: "Conversation width layout wide full",
            view: () => (
              <SettingRow title="Conversation width" description="How wide the transcript and composer run on large screens.">
                <Segmented
                  label="Conversation width"
                  value={width()}
                  options={WIDTHS}
                  onChange={(next) => {
                    save(WIDTH_KEY, next === "default" ? undefined : next);
                    setWidth(next);
                  }}
                />
              </SettingRow>
            ),
          },
        ],
      }),
    );
  },
});
