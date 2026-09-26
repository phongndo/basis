# @basis/plugin-skills

Provides `Skills`: discovery of [Agent Skills](https://agentskills.io) (a directory holding a `SKILL.md` with YAML frontmatter), on-demand loading of a skill's body, and the two ways the model learns about them: a compact section in the system prompt and a `skill` tool. Requires `Paths` and `Tools`.

## Use

```ts
import skills from "@basis/plugin-skills";
// makeCore([host, tools, skills, ...], { configs: { skills: { directories: ["/opt/shared-skills"] } } })
```

Sources, in precedence order (the first source to define a name wins; later ones are shadowed):

1. `<cwd>/.basis/skills`
2. `<cwd>/.agents/skills`
3. `<Paths.home>/skills` (`~/.basis/skills` by default)
4. `~/.agents/skills` (`$HOME`, falling back to the OS home directory)
5. `config.directories`, in the order given

A skill directory `deploy/` needs `deploy/SKILL.md`:

```markdown
---
name: deploy
description: Ship a release with the project's checklist.
disable-model-invocation: false
---
Instructions, in Markdown. Reference other files relative to this directory.
```

Frontmatter fields: `name` (required; `[a-z0-9-]`, single hyphens, max 64, must equal the directory name), `description` (required, max 1024), and optional `license`, `compatibility`, `metadata` (string map), `allowed-tools` (space-separated string or list), and `disable-model-invocation` (boolean, becomes `SkillInfo.userOnly`). A skill that fails validation is skipped and a `Notice` (level `warning`, source `skills`) names the file and the problem. Directories without `SKILL.md` are ignored.

## Config

| Key | Type | Meaning |
| --- | --- | --- |
| `directories` | `string[]`, optional | Extra roots, lowest precedence. |

The plugin accepts no config at all (`undefined`).

## Behavior

- `Skills.list` returns the cached index; `Skills.load(name)` re-reads the file and returns the body with the frontmatter stripped plus the `SkillInfo` (whose `path` is the skill directory); `Skills.refresh` rescans.
- The plugin watches every source root and its immediate subdirectories with `fs.watch` and rescans 200 ms after the last change. The watcher set is rebuilt after each automatic rescan, so a root created later is picked up once any other watched directory changes; `Skills.refresh` scans immediately but does not touch the watchers. Recursive watching is not used because on Linux it does not see into directories created after the watcher started.
- `AgentRequestHook` handler (order 10): when at least one non-user-only skill exists, appends a `# Skills` section to `request.system` listing `name: description (path)` per skill and a one-line instruction to load a skill with the `skill` tool. Bodies never enter the prompt unasked.
- `skill` tool, input `{ name }`: returns the SKILL.md body prefixed with the skill's directory so the model can read referenced files with the `read` tool. Unknown or user-only skills come back as an error result rather than a failed tool call.

## Rationale

- Problems are reported on every scan, not only the first: notices are losable, and observers registered by plugins that start in the same composition become visible only once the whole composition has activated, so a warning emitted during activation would otherwise be lost. The next refresh (including the automatic one after any change) repeats it.
- Shadowed duplicates are silent. The precedence order is the documented contract, and `SkillInfo.source` shows which root won.
- `allowed-tools` is validated but not enforced: gating is a `ToolExecuteHook` handler's job, and none is installed by default.
- User-only skills are indexed but neither offered in the prompt nor loadable through the tool. Invoking them (for example from a `/name` command) belongs to whichever plugin owns commands.
