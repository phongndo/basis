# @basis/cli

The `basis` command. `basis serve` runs the host app in the terminal. Every
other command is a client of an already-running host, for people and for
agents. `basis --help` lists the commands, flags, and exit codes.

```sh
nix develop -c pnpm basis status
nix develop -c pnpm basis session show <id> --json
```

## Behavior

- **Attach only.** The host is found through `$BASIS_HOME/transport.json`
  (`readDiscovery` from the transport plugin). With no running host the command
  fails with exit code 3 and code `NoHost`; it never starts one itself. Running a
  second host in-process would break the sessions store's single-writer
  assumption.
- **One-shot HTTP.** Calls use `POST /rpc/http` (NDJSON) through
  `makeHostRpcHttp` from `@basis/client`, and the CLI does not subscribe to
  `Host.Events`. So it is never offered interaction questions: a question asked
  while only the CLI is attached fails `Unavailable` rather than waiting on a
  terminal that cannot answer.
- **Machine-readable output.** With `--json`, results are the contract shapes
  (`HostInfo`, `PluginStatus`, `SessionInfo`, `SessionEvent`) on stdout, and
  failures are `{"error": {"code", "message", "subject"?}}` on stderr. `code` is
  the host's `HostError` code (`NotFound`, `Busy`, ...), or `Usage`, `NoHost`,
  `Unauthorized`, `Unreachable` from the CLI. `session show` returns the session
  and its current branch (root to leaf).
- **Directory scope.** `session list` shows sessions whose recorded cwd is the
  directory the command runs in (or `--cwd`), exactly; `--all` lists every
  session.
