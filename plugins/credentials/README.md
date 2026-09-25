# @basis/plugin-credentials

Provides `Credentials`; requires `Paths` (for `auth.json`) and `Interaction` (for login flows). No config.

## Resolution

`resolve(provider)`:

1. Environment variable named by convention: uppercase provider id, `-` becomes `_`, plus `_API_KEY` (`anthropic` → `ANTHROPIC_API_KEY`, `my-provider` → `MY_PROVIDER_API_KEY`). A non-empty value is an `api-key` credential.
2. `auth.json` at `Paths.auth`, a JSON object keyed by provider id with `Credential` values.
   - `api-key`: returned as is.
   - `command`: run with `sh -c` through `Bun.spawn`; the trimmed stdout becomes an `api-key` credential, cached for 60s per provider (invalidated by `set`/`remove`). A non-zero exit is an `Io` error carrying stderr; empty output is `NotFound`.
   - `oauth`: returned as is unless `expiresAt` is within 5 minutes, in which case it is refreshed under the store lock by the registered `AuthMethod.refresh` for the provider. The store is re-read under the lock, so a refresh done by another process is reused. A failing refresh, or no method able to refresh, is a `RefreshFailed` error, never a silent fallback to the stale token.

`list` reports provider ids and credential types without values. A store that exists but does not parse is an `Io` error, not an empty store.

## Store

Writes go to a temp file created with mode 0600 in the same directory, then `rename`, so readers never see a partial file. `set`, `remove`, `login`, and refresh serialize through `<auth>.lock`, created with `O_EXCL`; a waiting writer polls, and a lock older than 30s is treated as abandoned by a dead process and taken over. The lock is a cooperation convention between basis processes, not protection against other programs.

## Login methods

Provider plugins contribute `AuthMethod`s with `registerMethod`; a registration ends with its scope. `methods` lists them, adds an `api-key` entry for every provider that registered other methods, and one generic entry with provider `*`. `login(provider, methodId)` runs the method with the `Interaction` service and stores the result; `api-key` is built in for any provider id and asks for the key with `Interaction.ask({ secret: true })`. An empty or dismissed entry is `LoginFailed` and stores nothing.

There is deliberately no Anthropic subscription (Claude Pro/Max) OAuth flow.
