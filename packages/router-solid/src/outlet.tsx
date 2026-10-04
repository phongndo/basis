import { ErrorBoundary, Match, Switch, createEffect, on, untrack } from "solid-js";
import type { Accessor, Component, JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Match as RouteMatch, RouteEntry } from "@lemma/router";

/** An entry that shows a component: what the outlet renders. */
export interface ComponentEntry extends RouteEntry {
  readonly component: Component;
}

/** A page that threw while rendering. */
export interface RouteFailure<E extends ComponentEntry> {
  readonly error: unknown;
  /** The entry shown when it failed. */
  readonly entry: E;
  /** Renders the page again. */
  readonly retry: () => void;
}

export interface RouteOutletProps<E extends ComponentEntry> {
  readonly match: Accessor<RouteMatch<E>>;
  /** A known route with nothing registered at it (whatever provides its page is gone). Default: nothing. */
  readonly unavailable?: (match: Accessor<Extract<RouteMatch<E>, { readonly status: "unavailable" }>>) => JSX.Element;
  /** An address no route names. Default: nothing. */
  readonly unmatched?: (match: Accessor<Extract<RouteMatch<E>, { readonly status: "unmatched" }>>) => JSX.Element;
  /** A page that threw. Default: a short alert with the error. */
  readonly failed?: (failure: RouteFailure<E>) => JSX.Element;
}

function Failed<E extends ComponentEntry>(props: { outlet: RouteOutletProps<E>; error: unknown; entry: E; reset: () => void }) {
  // Another address is another chance: a page failing for one value may show the next.
  createEffect(
    on(
      () => props.outlet.match().location.href,
      () => props.reset(),
      { defer: true },
    ),
  );
  const failure: RouteFailure<E> = { error: props.error, entry: props.entry, retry: () => props.reset() };
  return (
    props.outlet.failed?.(failure) ?? (
      <div role="alert">
        This page failed: {props.error instanceof Error ? props.error.message : String(props.error)} <button onClick={() => props.reset()}>Try again</button>
      </div>
    )
  );
}

/**
 * Renders what the location shows. Entries sharing a component share one
 * instance across their routes (no remount moving between them). A page that
 * throws fails alone, inside the outlet, and is tried again on retry or the
 * next navigation.
 */
export function RouteOutlet<E extends ComponentEntry>(props: RouteOutletProps<E>): JSX.Element {
  const shown = () => {
    const match = props.match();
    return match.status === "matched" ? match : undefined;
  };
  const when = <S extends RouteMatch<E>["status"]>(status: S) => {
    const match = props.match();
    return match.status === status ? (match as Extract<RouteMatch<E>, { readonly status: S }>) : undefined;
  };
  return (
    <Switch>
      <Match when={shown()?.entry.component} keyed>
        {(component) => (
          <ErrorBoundary fallback={(error, reset) => <Failed outlet={props} error={error} entry={untrack(() => shown()?.entry) as E} reset={reset} />}>
            <Dynamic component={component} />
          </ErrorBoundary>
        )}
      </Match>
      <Match when={when("unavailable")}>{(match) => props.unavailable?.(match)}</Match>
      <Match when={when("unmatched")}>{(match) => props.unmatched?.(match)}</Match>
    </Switch>
  );
}
