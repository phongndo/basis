import { Schema } from "effect";
import { defineRoute } from "@lemma/router";

/*
 * The web app's addresses, apart from any plugin: the web app matches them
 * (`@lemma/router`), and a link to one works while nothing shows it. A thread
 * is a session as the web app shows it.
 */

/** A new thread. */
export const NewThreadRoute = defineRoute("thread.new", { path: "/" });
/** A thread, in one of its views (the web app's `Views` item ids; the first when absent). */
export const ThreadRoute = defineRoute("thread", { path: "/threads/:id/:view?" });
/** A settings section (General when absent); its search is the section's own state, as strings. */
export const SettingsRoute = defineRoute("settings", {
  path: "/settings/:section?",
  search: Schema.Record({ key: Schema.String, value: Schema.String }),
});
