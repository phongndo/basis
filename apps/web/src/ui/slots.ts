import { createSignal } from "solid-js";
import type { Accessor, Setter } from "solid-js";

/**
 * A named place plugins contribute to: a region of the screen (items carry a
 * component), or a list the app reads (actions, settings sections, views).
 * Declared once as a token, like a kernel hook; `T` is what each item carries.
 */
export interface Slot<T> {
  readonly name: string;
  /** Type witness only. */
  readonly _item?: T;
}

export const defineSlot = <T>(name: string): Slot<T> => ({ name });

/**
 * Every item has an id, unique within its slot by convention. Lower `order`
 * comes first; equal orders keep the order items were added in. Where a slot
 * shows one item (a region), the first one does, so a plugin takes over a
 * region by adding with a lower order than the item it replaces, or by the
 * bundled plugin being turned off.
 */
export type SlotItem<T> = T & { readonly id: string; readonly order?: number };

export interface SlotsService {
  /** Adds an item; returns its removal, which a plugin runs when it stops (`plugin.onCleanup`). */
  readonly add: <T>(slot: Slot<T>, item: SlotItem<T>) => () => void;
  /** The slot's items in order. Reactive. */
  readonly list: <T>(slot: Slot<T>) => readonly SlotItem<T>[];
  /** The first item, or undefined when the slot is empty. Reactive. */
  readonly first: <T>(slot: Slot<T>) => SlotItem<T> | undefined;
  /** The item with this id. Reactive. */
  readonly get: <T>(slot: Slot<T>, id: string) => SlotItem<T> | undefined;
  /** The same registry, recording `owner` as the plugin behind what it adds. `defineUiPlugin` hands each plugin its own. */
  readonly as: (owner: string) => SlotsService;
  /** What a plugin has added, by slot name and item id. Reactive. */
  readonly contributions: (owner: string) => readonly SlotContribution[];
}

export interface SlotContribution {
  readonly slot: string;
  readonly id: string;
}

interface Entry {
  readonly item: SlotItem<unknown>;
  readonly seq: number;
  readonly owner: string | undefined;
}

/** One signal per slot, so adding to one slot does not re-run readers of another. */
export function createSlots(): SlotsService {
  const slots = new Map<string, readonly [Accessor<readonly Entry[]>, Setter<readonly Entry[]>]>();
  let seq = 0;
  const signal = (name: string) => {
    let found = slots.get(name);
    if (found === undefined) {
      found = createSignal<readonly Entry[]>([]);
      slots.set(name, found);
    }
    return found;
  };
  const items = <T>(slot: Slot<T>) => signal(slot.name)[0]().map((entry) => entry.item as SlotItem<T>);
  // Bumped on every change, for the few readers that look across all slots.
  const [changes, setChanges] = createSignal(0);
  const service = (owner: string | undefined): SlotsService => ({
    add: (slot, item) => {
      const [, set] = signal(slot.name);
      const entry: Entry = { item: item as SlotItem<unknown>, seq: ++seq, owner };
      set((entries) => [...entries, entry].sort((a, b) => (a.item.order ?? 0) - (b.item.order ?? 0) || a.seq - b.seq));
      setChanges((count) => count + 1);
      return () => {
        set((entries) => entries.filter((candidate) => candidate !== entry));
        setChanges((count) => count + 1);
      };
    },
    list: items,
    first: (slot) => items(slot)[0],
    get: (slot, id) => items(slot).find((item) => item.id === id),
    as: service,
    contributions: (plugin) => {
      changes();
      return [...slots].flatMap(([name, [entries]]) =>
        entries()
          .filter((entry) => entry.owner === plugin)
          .map((entry) => ({ slot: name, id: entry.item.id })),
      );
    },
  });
  return service(undefined);
}
