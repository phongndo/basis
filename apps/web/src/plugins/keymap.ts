import { bindsTyping, matchesKeys, typing } from "../lib/keys.ts";
import { Actions, Dialogs, Interactions, Slots } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

/**
 * Keyboard shortcuts: every action with `keys`. The first action in order
 * whose keys match and whose `when` holds runs. While a dialog or question is
 * open only `global` actions do, and a key without a modifier waits until
 * focus leaves a text field unless the action says `whileTyping`.
 */
export default defineUiPlugin({
  id: "keymap",
  requires: { slots: Slots, dialogs: Dialogs, interactions: Interactions },
  setup: ({ slots, dialogs, interactions }, plugin) => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const modal = dialogs.current() !== undefined || interactions.open().length > 0;
      const inField = typing(event.target);
      for (const action of slots.list(Actions)) {
        if (action.keys === undefined || (modal && !action.global)) continue;
        const bindings: readonly string[] = typeof action.keys === "string" ? [action.keys] : action.keys;
        const binding = bindings.find((candidate) => matchesKeys(candidate, event));
        if (binding === undefined || (inField && bindsTyping(binding) && !action.whileTyping)) continue;
        if (action.when !== undefined && !action.when()) continue;
        event.preventDefault();
        action.run();
        return;
      }
    };
    document.addEventListener("keydown", onKey);
    plugin.onCleanup(() => document.removeEventListener("keydown", onKey));
  },
});
