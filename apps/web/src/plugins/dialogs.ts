import { createSignal } from "solid-js";
import { Dialogs } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";

/** Which dialog is open, by id; each dialog plugin shows itself when it is its turn. */
export default defineUiPlugin({
  id: "dialogs",
  provides: { dialogs: Dialogs },
  setup: () => {
    const [current, setCurrent] = createSignal<string>();
    return { dialogs: { current, open: (id: string | undefined) => void setCurrent(id) } };
  },
});
