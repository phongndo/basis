import { Schema } from "effect";
import { defineRoute } from "@lemma/router";

/*
 * The web app's addresses: one grammar for every way into it. The web app
 * matches them (`@lemma/router`) and the CLI prints them (`lemma open`). A
 * thread is a session as the web app shows it.
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

/**
 * The web app at `path` on the host serving it at `base`, with the token the page takes from `?token=` (and then hides).
 * Throws for a `path` that resolves to another origin: the token goes only to the host it belongs to.
 */
export const appUrl = (base: string, path: string, token?: string): string => {
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin) throw new Error(`Not an address in the app: ${path}`);
  if (token !== undefined && token !== "") url.searchParams.set("token", token);
  return url.href;
};
