import { Context, Data, Schema } from "effect";
import type { Effect } from "effect";
import { Hook } from "@basis/core";

/**
 * Questions for the human, answerable by whichever client is attached. The
 * host plugin that provides `Interaction` runs `InteractionHook`; UI and
 * transport plugins answer by handling it. No answerer means `Unavailable`.
 */
export const InteractionRequest = Schema.Union(
  Schema.Struct({ type: Schema.Literal("confirm"), id: Schema.String, title: Schema.String, detail: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("ask"), id: Schema.String, title: Schema.String, placeholder: Schema.optional(Schema.String), secret: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ type: Schema.Literal("select"), id: Schema.String, title: Schema.String, options: Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String, description: Schema.optional(Schema.String) })) }),
  /** Open a URL in the user's browser (OAuth). The answer is the pasted code or an empty string when a callback will arrive. */
  Schema.Struct({ type: Schema.Literal("open-url"), id: Schema.String, title: Schema.String, url: Schema.String, expectCode: Schema.Boolean }),
);
export type InteractionRequest = typeof InteractionRequest.Type;

export const InteractionAnswer = Schema.Union(
  Schema.Struct({ type: Schema.Literal("confirm"), value: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("ask"), value: Schema.String }),
  Schema.Struct({ type: Schema.Literal("select"), value: Schema.String }),
  Schema.Struct({ type: Schema.Literal("open-url"), value: Schema.String }),
);
export type InteractionAnswer = typeof InteractionAnswer.Type;

export class InteractionError extends Data.TaggedError("InteractionError")<{
  readonly reason: "Unavailable" | "Dismissed" | "Timeout";
  readonly message: string;
}> {}

export const InteractionHook = Hook.make<InteractionRequest, InteractionAnswer, InteractionError>("basis/interaction.request");

export class Interaction extends Context.Tag("basis/Interaction")<Interaction, {
  readonly confirm: (title: string, detail?: string) => Effect.Effect<boolean, InteractionError>;
  readonly ask: (title: string, options?: { readonly placeholder?: string; readonly secret?: boolean }) => Effect.Effect<string, InteractionError>;
  readonly select: <V extends string>(title: string, options: readonly { readonly value: V; readonly label: string; readonly description?: string }[]) => Effect.Effect<V, InteractionError>;
  readonly openUrl: (title: string, url: string, options?: { readonly expectCode?: boolean }) => Effect.Effect<string, InteractionError>;
  readonly notify: (message: string, level?: "info" | "warning" | "error") => Effect.Effect<void>;
}>() {}
