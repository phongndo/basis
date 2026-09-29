import { Cause, Effect, Exit, Scope, Stream } from "effect";
import type { Context } from "effect";
import { Show, createSignal } from "solid-js";
import { Dynamic, render } from "solid-js/web";
import { runPromise } from "@lemma/client";
import type { Host } from "@lemma/client";
import type { PluginInfo, PluginStatus, ReloadResult, UiComposition, UiFile } from "@lemma/contracts";
import { Diagnostic, makeLoader, ReloadError } from "@lemma/core";
import type { Loader, Plugin, PluginSource, ReloadReport } from "@lemma/core";
import { catalog, faultHistory, faultMessage, withReplacements } from "@lemma/plugin-host/catalog";
import { createClientPlugin } from "../plugins/client.ts";
import { Notify, Root, Slots, UiPlugins } from "./contracts.ts";
import type { UiPluginsService } from "./contracts.ts";
import { defineUiPlugin } from "./define.ts";
import { createFileLoader } from "./files.ts";
import { planUi } from "./plan.ts";
import type { UiPlan } from "./plan.ts";
import type { SlotsService } from "./slots.ts";

const APP_ID = "app";
/**
 * Always on, with everything they need ("Needed by …"): the switches that turn
 * plugins back on, and the frame they are shown in. Without these a switch on
 * the Plugins page could take the page itself away; `?safe` is the way back
 * from a UI file that breaks them.
 */
const PINNED: Readonly<Record<string, string>> = {
  [APP_ID]: "Runs the web app's plugins; with it off, nothing could turn them back on",
  "plugins-page": "Where plugins are turned back on; replace it with a UI file instead of turning it off",
  shell: "Draws the frame every other view shows in, settings included; replace it with a UI file instead of turning it off",
};
const EMPTY: UiComposition = { plugins: {}, enabledIn: {}, configIn: {}, files: [] };
/** How long the first paint waits for the host's `ui` rows before starting with the defaults. */
const FIRST_ROWS_MS = 3_000;

export interface BootOptions {
  readonly host: Host;
  readonly token: string | undefined;
  /** The app's own plugins, in order; the boot adds `client` and `app`. */
  readonly bundled: readonly Plugin[];
  /** Loads the object UI files receive (see `createFileLoader`). */
  readonly api: () => Promise<unknown>;
  readonly element: HTMLElement;
  /** `?safe`: ignore `ui` rows and UI files, running the app as shipped. */
  readonly safe: boolean;
}

/** `PluginInfo` for the page: the fault flattened to text, "disabled" for a plugin that is not loaded. */
const toStatus = (info: PluginInfo): PluginStatus => {
  const { fault, state, ...rest } = info;
  return {
    ...rest,
    state: state ?? "disabled",
    ...(fault === undefined
      ? {}
      : { fault: { phase: fault.phase, ...(fault.operation === undefined ? {} : { operation: fault.operation }), message: faultMessage(fault) } }),
  };
};

const toResult = (report: ReloadReport | undefined): ReloadResult => ({
  started: report?.started ?? [],
  restarted: report?.restarted ?? [],
  stopped: report?.stopped ?? [],
});

const timeout = <A,>(promise: Promise<A>, ms: number): Promise<A | undefined> =>
  Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);

/**
 * Runs the web app as a composition of UI plugins on the kernel, planned from
 * the bundled plugins, the host's `ui` rows, and UI files, and renders the
 * `root` slot. A `ui-changed` from the host (an edited config file, a file
 * added to `~/.lemma/ui`, a switch on the Plugins page) is applied in place:
 * only what changed, and what depends on it, restarts.
 */
export async function boot(options: BootOptions): Promise<void> {
  const { host, safe } = options;
  const [statuses, setStatuses] = createSignal<readonly PluginStatus[]>([]);
  const [files, setFiles] = createSignal<readonly UiFile[]>([]);
  const [problems, setProblems] = createSignal<readonly string[]>([]);
  const [slots, setSlots] = createSignal<SlotsService>();
  const fileLoader = createFileLoader(options.token, options.api);
  let ui: UiComposition = EMPTY;
  let plan!: UiPlan;
  let loader!: Loader;
  let queue: Promise<unknown> = Promise.resolve();
  const toasted = new Set<string>();
  const faults = faultHistory();

  /** A capability of the running composition, or undefined when no plugin provides it. */
  const serviceOf = <I, S>(tag: Context.Tag<I, S>): Promise<S | undefined> =>
    Effect.runPromiseExit(loader.core.run(tag)).then((exit) => (Exit.isSuccess(exit) ? exit.value : undefined));
  const refresh = async () => {
    const snapshot = await runPromise(loader.core.inspect);
    const infos = catalog({
      known: plan.known,
      composition: plan.composition,
      resolved: plan.resolved,
      snapshots: snapshot.plugins,
      hooks: snapshot.hooks,
      events: snapshot.events,
      faults: faults.get(),
      enabledIn: safe ? {} : ui.enabledIn,
      configIn: safe ? {} : ui.configIn,
      pinned: PINNED,
    });
    setStatuses(infos.map(toStatus));
    setSlots(await serviceOf(Slots));
  };
  /** New problems become warnings, once each, where a Notify is running; all of them stay listed on the Plugins page. */
  const report = async (found: readonly string[]) => {
    setProblems(found);
    const fresh = found.filter((problem) => !toasted.has(problem));
    for (const problem of found) toasted.add(problem);
    if (fresh.length === 0) return;
    for (const problem of fresh) console.warn(`lemma ui: ${problem}`);
    const notify = await serviceOf(Notify);
    for (const problem of fresh) notify?.toast({ level: "warning", source: "ui", message: problem });
  };

  const client = createClientPlugin(host);
  const service: UiPluginsService = {
    list: statuses,
    files,
    problems,
    safe,
    refresh,
    restart: async (plugin, restartOptions) => {
      await runPromise(loader.core.restart(plugin.id, restartOptions?.force ? { force: true } : undefined));
      await refresh();
    },
    setEnabled: async (plugin, enabled) => {
      // Turning on a plugin that provides what another does turns that one off, as on the host.
      const rows = withReplacements(plan.known, plan.composition, { [plugin.id]: { enabled } });
      const next = await host.ui.configure(rows, ui.enabledIn[plugin.id] === "project" ? { scope: "project" } : undefined);
      return toResult(await apply(next));
    },
    setConfig: async (plugin, values) => {
      const next = await host.ui.configure({ [plugin.id]: { values } }, ui.configIn[plugin.id] === "project" ? { scope: "project" } : undefined);
      return toResult(await apply(next));
    },
  };
  const app = defineUiPlugin({ id: APP_ID, provides: { plugins: UiPlugins }, setup: () => ({ plugins: service }) });
  const fixed = [client, app, ...options.bundled];

  const planFor = async (next: UiComposition) => {
    const loaded = safe ? { plugins: [], problems: [] } : await fileLoader.load(next.files);
    const planned = planUi(fixed, loaded.plugins, safe ? {} : next.plugins, new Set([APP_ID]));
    return { plan: planned, problems: [...loaded.problems, ...planned.unknown.map((id) => `ui row "${id}" names no web app plugin`)] };
  };
  const source: PluginSource = {
    resolve: (id) => {
      const found = plan.known.find((entry) => entry.plugin.id === id);
      return found !== undefined
        ? Effect.succeed(found.plugin)
        : Effect.fail(new Diagnostic({ severity: "error", pluginId: id, message: `No web app plugin "${id}"` }));
    },
  };
  const describeFailure = (cause: Cause.Cause<unknown>): string[] => {
    const failure = Cause.squash(cause);
    return failure instanceof ReloadError
      ? failure.diagnostics.map((diagnostic) => `${diagnostic.pluginId === undefined ? "" : `${diagnostic.pluginId}: `}${diagnostic.message}`)
      : [String(failure)];
  };

  /** Applies the host's rows and files; unchanged ones are a no-op. One at a time, in arrival order. */
  const apply = (next: UiComposition): Promise<ReloadReport | undefined> => {
    const run = queue.then(async () => {
      if (safe || JSON.stringify(next) === JSON.stringify(ui)) return undefined;
      const planned = await planFor(next);
      const previous = plan;
      // The source resolves ids against the plan being applied.
      plan = planned.plan;
      const exit = await Effect.runPromiseExit(loader.apply(planned.plan.resolved.composition));
      if (Exit.isSuccess(exit)) {
        ui = next;
        setFiles(next.files);
      } else plan = previous;
      await refresh();
      await report(Exit.isSuccess(exit) ? planned.problems : [...planned.problems, ...describeFailure(exit.cause)]);
      return Exit.isSuccess(exit) ? exit.value : undefined;
    });
    queue = run.catch(() => {});
    return run;
  };

  // The first paint waits briefly for the rows, so a replaced part never flashes the bundled one.
  /** The connection generation whose rows were fetched; -1 until one fetch succeeds. */
  let synced = -1;
  const firstRows = safe
    ? undefined
    : host.ui.composition().then((rows) => {
        synced = host.status().generation;
        return rows;
      });
  const initial = firstRows === undefined ? EMPTY : ((await timeout(firstRows, FIRST_ROWS_MS).catch(() => undefined)) ?? EMPTY);
  const scope = await runPromise(Scope.make());
  let first = await planFor(initial);
  plan = first.plan;
  let made = await Effect.runPromiseExit(Scope.extend(makeLoader({ source, composition: plan.resolved.composition }), scope));
  let bootProblems = first.problems;
  if (Exit.isSuccess(made)) ui = initial;
  else {
    // A composition the rows or files break still leaves the app as shipped.
    bootProblems = [...first.problems, ...describeFailure(made.cause)];
    first = await planFor(EMPTY);
    plan = first.plan;
    made = await Effect.runPromiseExit(Scope.extend(makeLoader({ source, composition: plan.resolved.composition }), scope));
    if (Exit.isFailure(made)) throw new Error(`The web app cannot start: ${describeFailure(made.cause).join("; ")}`);
  }
  loader = made.value;
  setFiles(ui.files);
  await refresh();

  render(() => {
    const root = () => slots()?.first(Root);
    return (
      <Show when={root()} keyed>
        {(entry) => <Dynamic component={entry.component} />}
      </Show>
    );
  }, options.element);
  await report(bootProblems);

  Effect.runFork(
    Stream.runForEach(loader.core.faults, (fault) =>
      Effect.promise(async () => {
        console.error(`lemma ui: ${fault.message}`, Cause.pretty(fault.cause));
        faults.record(fault);
        await refresh();
        const notify = await serviceOf(Notify);
        notify?.toast({ level: "error", source: fault.pluginId, message: faultMessage(fault) });
      }),
    ),
  );
  if (safe) return;
  /** Set once anything newer than the first fetch arrives, so a late first reply cannot undo it. */
  let superseded = false;
  host.onEvent((event) => {
    if (event.type !== "ui-changed") return;
    superseded = true;
    void apply(event.ui);
  });
  // A first reply slower than the first paint still applies.
  void firstRows?.then(
    (rows) => (superseded ? undefined : apply(rows)),
    () => {},
  );
  // Fetch again on every connection whose rows this page has not read: rows and files may have changed while it was down.
  host.onStatus((status) => {
    if (status.state !== "connected" || status.generation === synced) return;
    synced = status.generation;
    void host.ui.composition().then(
      (rows) => {
        superseded = true;
        return apply(rows);
      },
      () => {},
    );
  });
}
