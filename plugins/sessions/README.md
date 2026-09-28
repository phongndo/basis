# @basis/plugin-sessions

Provides `Sessions` (`@basis/contracts`): each session is an append-only tree of
`SessionEvent`s stored as one JSONL file. Requires `Paths`. No config.

```ts
const store = yield* Sessions;
const { id } = yield* store.create({ cwd });
const event = yield* store.append(id, { type: "title", title: "Fix the build" });
const branch = yield* store.branch(id);          // root → leaf
yield* store.checkout(id, event.id);             // later appends branch from here
```

## Storage

`<Paths.sessions>/<encoded cwd>/<createdAt ISO>_<id>.jsonl`. The cwd is encoded
pi-style (`/home/me/app` → `--home-me-app--`); the header's `cwd` is authoritative.

| Line | Shape |
| --- | --- |
| 1 | `{ "type": "session", "version": 1, id, cwd, createdAt }` |
| event | a `SessionEvent` (`seq`, `id`, `parent`, `at`, `data`); no top-level `type` |
| checkout | `{ "type": "checkout", "leaf": eventId, "at" }` |

`seq` counts events only (checkout lines do not advance it). The leaf is the last
event appended or the last checkout, whichever is later. The title is the latest
`title` event. Session ids are 12 url-safe random characters; event ids 8.

## Behavior

- **Durability.** `append` and `checkout` write through a per-session file handle
  and `fdatasync` before returning; `create` also fsyncs the directory. Appends to
  one session are serialized by a semaphore. The cost is one sync per event, and
  the agent appends only settled events (never stream deltas).
- **Crash tolerance.** Bytes after the last newline are a torn write: they are
  ignored when reading and cut off before the next append. Any *complete* line
  that does not decode, an unknown parent, a seq gap, or a checkout to nowhere
  makes the session `Corrupt`. Skipping such a line would silently change what the
  model saw.
- **Validation.** `append` validates the event against the schema first, so a line
  that could not be read back is never written. `parent` must exist (`InvalidParent`).
- **Listing.** `list` reads directory entries and `stat`s each file; a file is
  re-read (with `JSON.parse` only) when its size or mtime changed. Sessions this
  process has opened are served from memory. A file that cannot be read is left
  out with a `Notice` warning instead of failing the listing.
- **Memory.** A session opened for `events`, `branch`, `append`, or `checkout` stays
  in memory, with its handle open, for the plugin's lifetime.
- **Single writer.** Two processes appending to one session would interleave;
  the store assumes one host per sessions directory.
- `SessionAppended` and `SessionChanged` are published after each write. They are
  losable; the file is the source of truth.
