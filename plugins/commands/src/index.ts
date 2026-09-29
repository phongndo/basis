import { Cause, Effect, Layer } from "effect";
import type { Context } from "effect";
import { definePlugin, Events, PluginContext } from "@lemma/core";
import { CommandError, Commands, CommandsChanged, InteractionError } from "@lemma/contracts";
import type { Command, CommandInfo } from "@lemma/contracts";

type Service = Context.Tag.Service<typeof Commands>;

interface Entry {
  readonly command: Command;
  readonly info: CommandInfo;
}

const byCategoryThenTitle = (a: CommandInfo, b: CommandInfo): number =>
  (a.category ?? "").localeCompare(b.category ?? "") || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause));

export const makeRegistry: Effect.Effect<Service, never, Events | PluginContext> = Effect.gen(function* () {
  const events = yield* Events;
  const owner = yield* PluginContext;
  const entries = new Map<string, Entry>();

  const snapshot = () => [...entries.values()].map((entry) => entry.info).sort(byCategoryThenTitle);
  const changed = Effect.suspend(() => events.publish(CommandsChanged, { commands: snapshot() }));

  const register: Service["register"] = (command) =>
    Effect.gen(function* () {
      const { id: source } = yield* PluginContext;
      const { run: _run, ...fields } = command;
      const entry: Entry = { command, info: { ...fields, source } };
      yield* Effect.acquireRelease(
        Effect.suspend(() => {
          const existing = entries.get(command.id);
          if (existing !== undefined) {
            return Effect.fail(
              new CommandError({ command: command.id, reason: "Failed", message: `Command "${command.id}" is already registered by ${existing.info.source}` }),
            );
          }
          entries.set(command.id, entry);
          return changed;
        }),
        () => Effect.suspend(() => (entries.get(command.id) === entry && entries.delete(command.id) ? changed : Effect.void)),
      );
    });

  const run: Service["run"] = (id, context) =>
    owner.trace(
      `commands.run ${id}`,
      Effect.gen(function* () {
        const entry = entries.get(id);
        if (entry === undefined) {
          return yield* new CommandError({ command: id, reason: "NotFound", message: `No command "${id}"` });
        }
        const result = yield* Effect.suspend(() => entry.command.run(context)).pipe(
          Effect.catchAllCause((cause) => {
            if (Cause.isInterruptedOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>);
            const error = Cause.squash(cause);
            const dismissed = error instanceof InteractionError && error.reason === "Dismissed";
            return Effect.fail(
              new CommandError({
                command: id,
                reason: dismissed ? "Cancelled" : "Failed",
                message: dismissed ? `${entry.info.title} was cancelled` : message(error),
                cause: error,
              }),
            );
          }),
        );
        return result ?? {};
      }),
    );

  return { register, list: Effect.sync(snapshot), run } satisfies Service;
});

/**
 * Provides `Commands`, the registry every client lists and runs commands
 * through. Command plugins require `Commands` and register during activation.
 */
export default definePlugin({
  id: "commands",
  version: "0.1.0",
  provides: [Commands],
  layer: Layer.effect(Commands, makeRegistry),
});
