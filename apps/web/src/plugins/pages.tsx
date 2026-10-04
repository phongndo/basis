import { RouteOutlet } from "@lemma/router-solid";
import type { RouteFailure } from "@lemma/router-solid";
import { MainRegion, NewThreadRoute, Notify, Pages, Router, SettingsRoute, Slots } from "../ui/contracts.ts";
import type { Page } from "../ui/contracts.ts";
import type { SlotItem } from "../ui/slots.ts";
import { defineUiPlugin } from "../ui/define.ts";
import styles from "./pages.css?inline";

/**
 * The main region shows the page the address names: the `Pages` item for its
 * route. A route whose page's plugin is off says so, and the page returns
 * with the plugin, at the same address; an address no route names says that.
 * Pages that share a component share its instance across their routes. A page
 * that throws fails alone: the rest of the app stays, the failure names its
 * plugin, and it is tried again on retry or the next navigation.
 */
export default defineUiPlugin({
  id: "pages",
  styles,
  requires: { router: Router, slots: Slots, notify: Notify },
  setup: ({ router, slots, notify }, plugin) => {
    function Failed(props: { failure: RouteFailure<SlotItem<Page>> }) {
      const owner = slots.owner(Pages, props.failure.entry.id);
      const message = props.failure.error instanceof Error ? props.failure.error.message : String(props.failure.error);
      notify.toast({ level: "error", ...(owner === undefined ? {} : { source: owner }), message: `This page failed: ${message}` });
      return (
        <main class="page-missing">
          <div class="page-missing-body">
            <h1>This page failed</h1>
            <p class="muted">
              {owner === undefined ? "The page" : <>The page from the “{owner}” plugin</>} threw an error: <code>{message}</code>
            </p>
            <p>
              <button class="button small" onClick={() => props.failure.retry()}>
                Try again
              </button>{" "}
              <a class="button small" href={router.href(SettingsRoute, { section: "plugins" }, owner === undefined ? {} : { plugin: owner, kind: "web" })}>
                Plugins
              </a>
            </p>
          </div>
        </main>
      );
    }
    const missing = (title: string, detail: string) => (
      <main class="page-missing">
        <div class="page-missing-body">
          <h1>{title}</h1>
          <p class="muted">{detail}</p>
          <p>
            <a class="button small" href={router.href(NewThreadRoute, {})}>
              New thread
            </a>{" "}
            <a class="button small" href={router.href(SettingsRoute, { section: "plugins" })}>
              Plugins
            </a>
          </p>
        </div>
      </main>
    );
    const Outlet = () => (
      <RouteOutlet
        match={router.match}
        failed={(failure) => <Failed failure={failure} />}
        unavailable={(match) =>
          missing(
            "This page is off",
            `Nothing shows “${match().route.id}” pages right now: the plugin that does is off or failed. It returns here when the plugin is back on.`,
          )
        }
        unmatched={(match) => missing("No page here", `Nothing in the app lives at ${match().location.pathname}.`)}
      />
    );
    plugin.onCleanup(slots.add(MainRegion, { id: "pages", component: Outlet }));
  },
});
