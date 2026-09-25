import { Context, Data, Schema } from "effect";
import type { Effect, Option, Scope } from "effect";
import type { Interaction } from "./interaction.ts";

/** Stored per provider id in `auth.json` (mode 0600). `command` values are resolved by running the command. */
export const Credential = Schema.Union(
  Schema.Struct({ type: Schema.Literal("api-key"), key: Schema.String }),
  Schema.Struct({ type: Schema.Literal("oauth"), access: Schema.String, refresh: Schema.String, expiresAt: Schema.Number, scope: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("command"), command: Schema.String }),
);
export type Credential = typeof Credential.Type;

export class CredentialError extends Data.TaggedError("CredentialError")<{
  readonly provider: string;
  readonly reason: "NotFound" | "Expired" | "RefreshFailed" | "Io" | "LoginFailed";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** A login flow a provider plugin contributes (device code, PKCE, key entry). Appears in `/login`. */
export interface AuthMethod {
  readonly provider: string;
  readonly id: string;
  readonly label: string;
  readonly login: (interaction: Context.Tag.Service<Interaction>) => Effect.Effect<Credential, CredentialError>;
  /** Refresh an OAuth credential; absent means the token cannot be refreshed. */
  readonly refresh?: (credential: Extract<Credential, { type: "oauth" }>) => Effect.Effect<Credential, CredentialError>;
}

export class Credentials extends Context.Tag("basis/Credentials")<Credentials, {
  /**
   * Resolution order: environment variable named by the provider, then the store.
   * OAuth credentials are refreshed under a file lock when near expiry; a failed
   * refresh is an error, never a silent fallback.
   */
  readonly resolve: (provider: string) => Effect.Effect<Option.Option<Credential>, CredentialError>;
  readonly set: (provider: string, credential: Credential) => Effect.Effect<void, CredentialError>;
  readonly remove: (provider: string) => Effect.Effect<void, CredentialError>;
  readonly list: Effect.Effect<readonly { readonly provider: string; readonly type: Credential["type"] }[], CredentialError>;
  readonly registerMethod: (method: AuthMethod) => Effect.Effect<void, never, Scope.Scope>;
  readonly methods: Effect.Effect<readonly { readonly provider: string; readonly id: string; readonly label: string }[]>;
  readonly login: (provider: string, methodId: string) => Effect.Effect<Credential, CredentialError>;
}>() {}
