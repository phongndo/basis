import { Slots } from "../ui/contracts.ts";
import { defineUiPlugin } from "../ui/define.ts";
import { createSlots } from "../ui/slots.ts";

/** The registry every slot lives in. Replacing it restarts every plugin that contributes, with the new registry. */
export default defineUiPlugin({
  id: "slots",
  provides: { slots: Slots },
  setup: () => ({ slots: createSlots() }),
});
