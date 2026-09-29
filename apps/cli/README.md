# @lemma/cli

The `lemma` command: everything the web app can do, from a shell, for people
and for agents. `lemma serve` runs the host app in the terminal; every other
command is a client of an already-running host. `lemma --help` lists the
commands, flags, and exit codes.

```sh
nix develop -c pnpm lemma status
nix develop -c pnpm lemma run new "fix the failing test" --follow
nix develop -c pnpm lemma inspect <session> --filter "is:error" --json
```

The CLI and the web app share their logic through `@lemma/contracts`: the
trajectory projection, the ledger of records, the filter language, sorting,
time ranges, and prompt diffs are one implementation, so the two show the same
records and accept the same queries.

## Behavior

- **Attach only.** The host is found through `$LEMMA_HOME/transport.json`
  (`readDiscovery` from the transport plugin). With no running host the command
  fails with exit code 3 and code `NoHost`; it never starts one itself. Running a
  second host in-process would break the sessions store's single-writer
  assumption.
- **Two connections, as the transport intends.** Calls use one-shot HTTP
  (`POST /rpc/http`, `makeHostRpcHttp`). Commands that watch the host —
  `run --follow`, `events`, `login`, `questions`, `answer` — also open the
  WebSocket the web app uses and subscribe to `Host.Events`.
- **Questions.** While subscribed, the CLI is offered the host's questions (a
  login's API key, a tool that asks to confirm). `--answer <value>` answers them
  in order; otherwise `--questions ask` prompts at the terminal (the default when
  stdin is one), `ignore` leaves them to another client such as an open web app
  and prints how to answer from the CLI (the default otherwise, so an agent never
  answers for the person), and `dismiss` fails them. `questions`, `answer`, and
  `dismiss` work on any open question from a separate process.
- **Machine-readable output.** With `--json`, results are the contract shapes
  (`HostInfo`, `PluginStatus`, `SessionInfo`, `SessionEvent`, `ModelInfo`, …) on
  stdout, and failures are `{"error": {"code", "message", "subject"?}}` on
  stderr. `code` is the host's `HostError` code (`NotFound`, `Busy`, ...), or
  `Usage`, `NoHost`, `Unauthorized`, `Unreachable` from the CLI. Streams
  (`run --follow --json`, `events --json`) are NDJSON; `run --follow` ends with a
  `{"type": "result", …}` line. `inspect --records` returns flat record
  summaries (`recordSummary`), not records, which point at their whole turn.
- **Exit codes.** 0 ok; 1 the host refused or failed the request, or the turn
  did not end `done`; 2 usage; 3 no host, or it could not be reached or rejected
  the token. A closed pipe (`… | head`) ends output quietly.
- **Directory scope.** `session list` shows sessions whose recorded cwd is the
  directory the command runs in (or `--cwd`), exactly; `--all` lists every
  session. `session new` and `run new` create the session there too, and
  `workspace` commands default to it.
