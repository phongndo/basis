# @basis/plugin-sessions

Provides `Sessions` from `@basis/contracts`: an append-only tree of entries per session, stored as one JSONL file. Requires `Paths` for the storage root. No config.

```ts
import sessions from "@basis/plugin-sessions";
const core = yield* makeCore([host, sessions]);
```

```ts
const store = yield* Sessions;
const info = yield* store.create(cwd);
const entry = yield* store.append(info.id, { type: "message", message });
const path = yield* store.context(info.id);        // root → leaf, cut at the last compaction
yield* store.checkout(info.id, entry.id);          // later appends branch from here
```

Run `nix develop -c bun run plugins/sessions/examples/branch.ts` for a branching walkthrough.

## Storage

`<Paths.sessions>/<project-key>/<sessionId>.jsonl`, where the project key is the sanitized tail of the working directory plus eight hex characters of its SHA-256 (`projectKey(cwd)`), so two paths that sanitize alike do not collide.

Every line is one JSON record, encoded through the contract schemas (dates are ISO strings):

| Record | Meaning |
| --- | --- |
| `{ "type": "header", id, cwd, createdAt, updatedAt }` | First line. A file whose first line is not a readable header is `Corrupt`. |
| `{ "type": "entry", id, parent, at, payload }` | A `SessionEntry`. Appending moves the leaf to it. |
| `{ "type": "leaf", entryId }` | A checkout. The leaf survives a restart because it is in the file. |

The file is never rewritten. The current state is the fold of the file in order: the leaf is the last entry appended or the last `leaf` record, whichever comes later; the title is the last `title` entry; `updatedAt` is the latest entry time. `setTitle` therefore appends a `title` entry through the normal path, so it is durable, ordered with everything else, and visible in `entries`. Consumers that render the model's view skip entries that are not messages.

## Behavior

- `append` is durable before it returns: the record is written and `fdatasync`ed through a file handle kept open per session for the plugin's lifetime. Appends to one session are serialized by a semaphore; ids are UUIDs and `at` is the current clock time.
- `context` walks parents from the leaf and stops at the first compaction entry it meets, which is kept as the first element. Entries before it are omitted from the model's view but stay in the file and in `entries`.
- `entries` streams every entry in file order from the in-memory index; it is a snapshot at call time.
- The index (entries by id, children by parent) is built the first time a session is opened. `list` scans directories every call and parses only files it has not seen; parsed headers are cached and kept current by `append` and `checkout`, so a listing after an append reflects the new `updatedAt` without rereading. Results are newest first; `{ cwd }` limits the scan to that project directory.
- Unreadable lines, an entry whose parent is unknown, and a `leaf` record pointing at nothing are skipped with a `Notice` (level `warning`, source `sessions`) naming the file and line. An entry that depended on a skipped one is skipped too, so the tree stays consistent. In `list`, a session whose header cannot be read is reported the same way and left out instead of failing the listing; `get` on it fails with `Corrupt`.
- `SessionAppended` and `SessionChanged` are published after the write; they are informational. The file is the source of truth.

## Rationale

Records are self-describing (`type`) so the format can grow without a version field; a reader skips what it does not understand. Sessions are found by id across project directories because callers hold ids, not working directories; the first lookup of an unknown id lists the store once and the result is cached.
