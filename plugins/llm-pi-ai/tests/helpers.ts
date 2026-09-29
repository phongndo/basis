import { Effect, Layer } from "effect";
import type { AuthContext } from "@earendil-works/pi-ai";
import { PluginContext, definePlugin, makeCore } from "@lemma/core";
import type { Plugin } from "@lemma/core";
import { Credentials, Interaction, Notice } from "@lemma/contracts";
import type { Credential, InteractionError, Llm, NoticePayload } from "@lemma/contracts";

export function fakeCredentials(initial: Record<string, Credential> = {}) {
  const store = new Map<string, Credential>(Object.entries(initial));
  const lock = Effect.unsafeMakeSemaphore(1);
  const service: typeof Credentials.Service = {
    read: (provider) => Effect.sync(() => store.get(provider)),
    list: Effect.sync(() => [...store].map(([provider, credential]) => ({ provider, type: credential.type }))),
    modify: (provider, update) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const next = yield* update(store.get(provider));
          if (next !== undefined) store.set(provider, next);
          return store.get(provider);
        }),
      ),
    remove: (provider) => Effect.sync(() => void store.delete(provider)),
  };
  const plugin = definePlugin({ id: "credentials", provides: [Credentials], layer: Layer.succeed(Credentials, service) });
  return { store, service, plugin };
}

export type Question =
  | { readonly type: "ask"; readonly title: string; readonly secret?: boolean; readonly placeholder?: string }
  | { readonly type: "select"; readonly title: string; readonly options: readonly string[] };

/** Answers questions with `answer`; every question is recorded. */
export function fakeInteraction(answer: (question: Question) => Effect.Effect<string, InteractionError>) {
  const asked: Question[] = [];
  const respond = (question: Question) =>
    Effect.suspend(() => {
      asked.push(question);
      return answer(question);
    });
  const service: typeof Interaction.Service = {
    confirm: () => Effect.succeed(true),
    ask: (title, options) => respond({ type: "ask", title, ...options }),
    select: (title, options) => respond({ type: "select", title, options: options.map((option) => option.value) }) as Effect.Effect<never, InteractionError>,
  };
  const plugin = definePlugin({ id: "interaction", provides: [Interaction], layer: Layer.succeed(Interaction, service) });
  return { asked, plugin };
}

/** Records every `Notice` through a plugin observer, so no publish races a late subscriber. */
export function noticeRecorder() {
  const notices: NoticePayload[] = [];
  const plugin = definePlugin({
    id: "notices",
    layer: Layer.effectDiscard(
      Effect.gen(function* () {
        const context = yield* PluginContext;
        yield* context.observe(Notice, (notice) => Effect.sync(() => void notices.push(notice)), { overflow: "suspend" });
      }),
    ),
  });
  return { notices, plugin };
}

export const envContext = (env: Record<string, string> = {}): AuthContext => ({
  env: async (name) => env[name],
  fileExists: async () => false,
});

export const runWith = <A, E>(plugins: readonly Plugin[], body: Effect.Effect<A, E, Llm>, configs: Record<string, unknown> = {}): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const core = yield* makeCore(plugins, { configs });
        return yield* core.run(body) as Effect.Effect<A, E | unknown>;
      }),
    ) as Effect.Effect<A>,
  );
