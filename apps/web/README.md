# @lemma/web

The web app, and how to change any part of it. It is a composition of plugins
on the same kernel as the host (`@lemma/core`): every part — the models of
host state, the frame, the sidebar, the chat, the composer, the palette, each
settings section — is a plugin that can be turned off or replaced. With every
plugin off, the page is blank.

```sh
nix develop -c pnpm --filter @lemma/web dev    # http://127.0.0.1:5173/?mock runs against an in-browser fake host
nix develop -c pnpm --filter @lemma/web test
```

## How it runs

[`ui/boot.tsx`](src/ui/boot.tsx) plans the composition from three inputs and
renders whatever fills the `root` slot:

1. The bundled plugins, listed in [`plugins/index.ts`](src/plugins/index.ts).
2. UI files in `~/.lemma/ui/` and, for a trusted project, `<project>/.lemma/ui/`:
   `.js`/`.mjs` files load as plugins, `.css` files apply over the app's
   styles (every color, radius, width, and stacking level is a `--` token in
   [`styles.css`](src/styles.css), and the app's own styles sit in cascade
   layers a file's rules always win over).
3. The `"ui"` rows of `config.jsonc`, which work like `"plugins"` rows do for
   the host: `{ "ui": { "composer": { "enabled": false }, "chat": { "config": { "expandTools": true } } } }`.

The host serves the files (under `/api`, with the token) and tells the page
when any input changes, so edits apply without a reload: only the plugins that
changed, and what depends on them, restart. The planner is the host's own
(`resolveComposition`), so turning a plugin off halts the plugins that need it,
and they return with it. A plugin from a file with a bundled plugin's id runs
in its place; one that provides a capability a bundled plugin provides turns
that plugin off unless a row says otherwise.

Change the rows from the Plugins settings page, an inspector over the host's
plugins and the web app's: a table to filter (`is:failed kind:web -is:off`)
and, for the selected plugin, why it is in its state, its wiring (what it
provides and requires and who is on the other end, the hooks and events it
takes part in, and what it contributes: tools, commands, slot items), its
settings form (from its config Schema), and its
recent faults. Or from a shell:

```sh
lemma ui                               # rows and files
lemma plugins show agent               # a host plugin's wiring and faults, as the inspector shows them
lemma ui disable sidebar               # (--project for the project's config)
lemma ui config chat expandTools true  # one config field; --unset removes it
```

Open the app with `?safe` to ignore rows and files: the way back from a
customization that broke the page, including one that turned the settings off.

## Writing a plugin

A plugin requires capabilities, provides capabilities, and contributes to
slots. [`ui/contracts.ts`](src/ui/contracts.ts) lists them all; the bundled
plugins use nothing else.

- **Capabilities** are services with one provider: the host's state
  (`Sessions`, `Models`, `Workspace`, `HostPlugins`, `Commands`,
  `Interactions`, the `Client` connection) and screen state (`Dialogs`,
  `Settings`, `Layout`). Replacing a provider restarts its dependents with the
  new one.
- **Slots** are places any number of plugins add to: regions of the screen
  (`Root`, `SidebarRegion`, `MainRegion`, `ComposerRegion`, `Layers`, …), where
  the first item by `order` shows, and lists: `Actions` (the palette and
  shortcuts), `Views`, `SettingsSections`, `SettingsGroups`, `ToolViews` (a
  tool's summary and body, in the chat and the trajectory), `CodeBlocks` (how
  fenced code renders: `highlight` and `diagrams` fill it), `PaletteSources`
  (what the palette searches), `SessionHeader`, `SidebarActions`,
  `ComposerActions`, `WorkspaceBarItems`, `PluginTabs` (the Plugins page
  inspector), `TrajectoryTabs` and `TrajectoryActions`. The bundled plugins add
  their own buttons, tabs, and sources through these same slots. Take over a
  region by adding with a lower `order`, or turn its plugin off. An item leaves
  when the plugin that added it stops.
- **Parts** are the pieces plugins draw with, each a region-like slot: the
  shared ones (`markdown`, `dialog`, `popover`, `toggle`, `setting-row`,
  `segmented`, `config-form`, `provider-logo`, and `icon` for every icon, all
  from the `kit` plugin) and a view's own (`chat.user`, `chat.thinking`,
  `chat.tool`, `chat.work`, `chat.working`, `chat.turn-footer`,
  `sidebar.row`, `providers.row`). Replace one
  everywhere by adding an item with an `order` below `DEFAULT_PART_ORDER`;
  `api.defaults` holds the bundled implementations to wrap or fall back to.

```js
// ~/.lemma/ui/quiet-thoughts.js: thoughts as a single muted line, never expanded
export default ({ defineUiPlugin, contracts: { Slots, ChatThinkingPart }, html }) =>
  defineUiPlugin({
    id: "quiet-thoughts",
    requires: { slots: Slots },
    setup: ({ slots }, plugin) => {
      plugin.onCleanup(slots.add(ChatThinkingPart, { id: "quiet", order: 0, component: (props) => html`<p class="muted small">thought for a moment</p>` }));
    },
  });
```

[`defineUiPlugin`](src/ui/define.ts) writes one in plain TypeScript. `setup`
runs in its own Solid root; release what it adds with `plugin.onCleanup`. Its
`styles` (a stylesheet as a string) apply while it runs and leave with it. A
plugin can declare its own slots and parts for others (`defineSlot`,
`definePart`); a name is one slot across the page, so files that use the same
name share it.

A file needs no build step: its default export may be a function that receives
[the api](src/ui/api.ts) — the page's Solid, the contracts, `defineUiPlugin`,
the parts (`components`, `icons`, `parts`) and their `defaults`, and `html`,
Solid's JSX without a compiler.

```js
// ~/.lemma/ui/tool-count.js
export default ({ defineUiPlugin, contracts: { Slots, Sessions, SidebarFooter }, html }) =>
  defineUiPlugin({
    id: "tool-count",
    requires: { slots: Slots, sessions: Sessions },
    setup: ({ slots, sessions }, plugin) => {
      const calls = () => sessions.branch().filter((event) => event.data.type === "message" && event.data.message.role === "toolResult").length;
      plugin.onCleanup(slots.add(SidebarFooter, { id: "tool-count", order: 50, component: () => html`<span class="muted small">${calls} tool calls</span>` }));
    },
  });
```

Give it a `config` Schema (from `api.Schema`) and its fields appear on the
Plugins page. A file is one ES module: bundle anything it imports, and import
nothing it can get from the api, so it shares the page's module instances.
UI files run with the page's permissions and token, like host plugins run with
the host's.
