import { Schema } from "effect";
import * as solid from "solid-js";
import html from "solid-js/html";
import * as store from "solid-js/store";
import * as web from "solid-js/web";
import { definePlugin, Event, Hook } from "@lemma/core";
import { ConfigForm } from "../components/config-form.tsx";
import { Dialog } from "../components/dialog.tsx";
import * as icons from "../components/icons.tsx";
import { Markdown } from "../components/markdown.tsx";
import { Popover } from "../components/popover.tsx";
import { Segmented, SettingRow } from "../components/setting-row.tsx";
import { Toggle } from "../components/toggle.tsx";
import * as contracts from "./contracts.ts";
import { defineUiPlugin } from "./define.ts";
import { defineSlot } from "./slots.ts";

/**
 * What a UI file's default export receives when it is a function: the page's
 * own module instances, so a plugin shares Solid's reactivity and the
 * contracts' tags with the app, and needs no build step (`html` is Solid's
 * tagged template, JSX without a compiler).
 *
 *   export default ({ defineUiPlugin, contracts: { Slots, Actions }, html }) =>
 *     defineUiPlugin({ id: "hello", requires: { slots: Slots }, setup: ({ slots }, plugin) => { … } });
 */
export const api = {
  defineUiPlugin,
  defineSlot,
  contracts,
  solid,
  web,
  store,
  html,
  components: { ConfigForm, Dialog, Markdown, Popover, Segmented, SettingRow, Toggle },
  icons,
  /** For plugins written against the kernel directly. */
  core: { definePlugin, Event, Hook },
  /**
   * Enough of Effect Schema to declare a config, which the Plugins page turns
   * into a form. Only these members, so the rest of Schema stays out of the app.
   */
  Schema: {
    Array: Schema.Array,
    Boolean: Schema.Boolean,
    Int: Schema.Int,
    Literal: Schema.Literal,
    Number: Schema.Number,
    String: Schema.String,
    Struct: Schema.Struct,
    between: Schema.between,
    nonNegative: Schema.nonNegative,
    optional: Schema.optional,
    optionalWith: Schema.optionalWith,
    positive: Schema.positive,
    propertySignature: Schema.propertySignature,
  },
};

export type UiApi = typeof api;
