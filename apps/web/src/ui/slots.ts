import { createSignal } from "solid-js";
import type { Accessor, Component, Setter } from "solid-js";
import { Registry } from "@lemma/core";
import type { Contribution, PluginContext, Registries } from "@lemma/core";
import { Effect } from "effect";
import type { Stream } from "effect";

/**
 * A named place plugins contribute to: a region of the screen (items carry a
 * component), or a list the app reads (actions, settings sections, views).
 * `T` is what each item carries. A slot is a core registry: an item belongs to
 * the plugin that added it and leaves with it, and the Plugins page shows who
 * contributes what.
 */
export type Slot<T> = Registry<SlotItem<T>>;

const named = new Map<string, Slot<any>>();

/** The slot with this name: the same token each time, so a UI file loaded again after an edit, or two files naming one slot, share it. */
export const defineSlot = <T>(name: string): Slot<T> => {
  let slot = named.get(name);
  if (slot === undefined) {
    slot = Registry.make<SlotItem<any>>(name, { key: (item) => item.id });
    named.set(name, slot);
  }
  return slot as Slot<T>;
};

/** A region filled by one component: the first item wins. */
export interface Region<P extends Record<string, any> = {}> {
  readonly component: Component<P>;
}

/**
 * A replaceable piece of UI that plugins draw with: a region slot, named
 * `part.<name>`, whose first item by order renders wherever the part is used
 * (see `ui/parts.tsx`). A plugin replaces a part by adding an item with a
 * lower order than the default's; `P` is the props every provider takes.
 */
export type Part<P extends Record<string, any>> = Slot<Region<P>>;
export const definePart = <P extends Record<string, any>>(name: string): Part<P> => defineSlot<Region<P>>(`part.${name}`);

/** Where the defaults of parts are added: a replacement uses a lower order. */
export const DEFAULT_PART_ORDER = 100;

/**
 * Every item has an id, unique within its slot by convention. Lower `order`
 * comes first; equal orders go by the contributing plugin's id, then the
 * order that plugin added them in. Where a slot shows one item (a region),
 * the first one does, so a plugin takes over a region by adding with a lower
 * order than the item it replaces, or by the bundled plugin being turned off.
 */
export type SlotItem<T> = T & { readonly id: string; readonly order?: number };

type Contributor = PluginContext["Type"];

export interface SlotsService {
  /** Adds an item as this plugin's; returns its removal. It also leaves when the plugin stops, and an add once it is stopping does nothing. */
  readonly add: <T>(slot: Slot<T>, item: SlotItem<T>) => () => void;
  /** The slot's items in order. Reactive. */
  readonly list: <T>(slot: Slot<T>) => readonly SlotItem<T>[];
  /** The first item, or undefined when the slot is empty. Reactive. */
  readonly first: <T>(slot: Slot<T>) => SlotItem<T> | undefined;
  /** The item with this id. Reactive. */
  readonly get: <T>(slot: Slot<T>, id: string) => SlotItem<T> | undefined;
  /** The id of the plugin that added the item with this id (to name it when the item fails). Reactive. */
  readonly owner: <T>(slot: Slot<T>, id: string) => string | undefined;
  /** The same registry, adding as `contributor`'s. `defineUiPlugin` hands each plugin its own. */
  readonly as: (contributor: Contributor) => SlotsService;
}

/** Runs a synchronous Effect: everything here only reads or changes registries in memory. */
export type RunSync = <A, E>(effect: Effect.Effect<A, E>) => A;

/**
 * Slots over the core's registries, with a Solid signal per slot so views
 * re-render when it changes: from a local add or removal at once, and from a
 * plugin starting or stopping through the registry's change stream, which
 * `watch` runs for as long as the slots' plugin does.
 */
export function createSlots(
  registries: Registries["Type"],
  contributor: Contributor,
  run: RunSync,
  watch: (name: string, changes: Stream.Stream<readonly Contribution<unknown>[]>, apply: (items: readonly Contribution<unknown>[]) => void) => void,
): SlotsService {
  const signals = new Map<string, readonly [Accessor<readonly Contribution<unknown>[]>, Setter<readonly Contribution<unknown>[]>]>();
  const signal = <T>(slot: Slot<T>) => {
    let found = signals.get(slot.name);
    if (found === undefined) {
      found = createSignal<readonly Contribution<unknown>[]>(run(registries.items(slot)) as readonly Contribution<unknown>[], { equals: false });
      signals.set(slot.name, found);
      const [, set] = found;
      watch(slot.name, registries.changes(slot) as Stream.Stream<readonly Contribution<unknown>[]>, set);
    }
    return found;
  };
  const refresh = <T>(slot: Slot<T>) => signal(slot)[1](run(registries.items(slot)) as readonly Contribution<unknown>[]);
  const items = <T>(slot: Slot<T>) => signal(slot)[0]().map((contribution) => contribution.item as SlotItem<T>);
  const service = (owner: Contributor): SlotsService => ({
    add: (slot, item) => {
      // A stopping plugin's effects can still run; what they add would leave with it at once.
      const remove = run(
        owner.add(slot, item, { order: item.order ?? 0 }).pipe(
          Effect.catchIf(
            (error) => error._tag === "CoreClosed" || error.reason === "OwnerClosed",
            () => Effect.succeed(undefined),
          ),
        ),
      );
      if (remove === undefined) return () => {};
      refresh(slot);
      return () => {
        run(remove);
        refresh(slot);
      };
    },
    list: items,
    first: (slot) => items(slot)[0],
    get: (slot, id) => items(slot).find((item) => item.id === id),
    owner: (slot, id) => signal(slot)[0]().find((contribution) => (contribution.item as SlotItem<unknown>).id === id)?.pluginId,
    as: service,
  });
  return service(contributor);
}
