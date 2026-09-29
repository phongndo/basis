# @lemma/plugin-commands-builtin

The host's own commands, as three plugins so a composition missing one
capability still gets the others. Each requires `Commands` and `Interaction`,
plus the capability named below. They are all exclusive because the registry
rejects duplicate ids.

| Plugin               | Requires      | Commands                                                                                                |
| -------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `commands-host`      | `HostControl` | `host.reload` (Reload config), `host.restart-plugin` (Restart plugin…: asks which)                      |
| `commands-llm`       | `Llm`         | `llm.logout` (Log out of a provider…: asks which configured provider)                                   |
| `commands-workspace` | `Workspace`   | `workspace.checkout` (Switch branch…: asks which), `workspace.new-branch` (Create branch…: asks a name) |

The git commands act on the caller's `cwd`. Switch branch leaves out the current
branch and any branch checked out in another worktree. Picking a remote branch
(`origin/x`) switches to the local `x`. The command lists (`hostCommands`,
`llmCommands`, `workspaceCommands`) are exported for reuse and testing. No config.
