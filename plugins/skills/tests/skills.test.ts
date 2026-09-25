import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Either } from "effect";
import type { Scope } from "effect";
import { Hooks, makeCore } from "@basis/core";
import { AgentRequestHook, LlmRequest, Skills, ToolInvocation, Tools } from "@basis/contracts";
import skills, { parseFrontmatter, renderSection, sources } from "../src/index.ts";
import { Fixture, fakePaths, fakeTools, noticeCollector, waitFor } from "./fakes.ts";

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect));

let fixture: Fixture;
let notices: { level: string; message: string; source?: string }[];
const originalHome = process.env["HOME"];

beforeEach(() => {
  fixture = new Fixture();
  notices = [];
  // `~/.agents/skills` is resolved from the OS home; point it at the fixture.
  process.env["HOME"] = fixture.userHome;
});
afterEach(() => {
  process.env["HOME"] = originalHome;
  fixture.dispose();
});

const mount = (config?: { directories: string[] }) =>
  makeCore([fakeTools, fakePaths(fixture.cwd, fixture.home), noticeCollector(notices), skills], { configs: config ? { skills: config } : {} });

const invocation = (name: string, input: unknown) => new ToolInvocation({ sessionId: "s", toolCallId: "c", name, input, cwd: "/" });

describe("frontmatter", () => {
  test("accepts the specification's fields and maps disable-model-invocation to userOnly", () => {
    const parsed = parseFrontmatter([
      "---", "name: deploy", "description: Ship it", "license: MIT", "compatibility: needs docker",
      "metadata:", "  author: me", "allowed-tools: bash read", "disable-model-invocation: true", "---", "", "# Deploy", "steps",
    ].join("\n"), "deploy");
    expect(Either.isRight(parsed) && parsed.right).toEqual({
      name: "deploy", description: "Ship it", license: "MIT", compatibility: "needs docker",
      metadata: { author: "me" }, allowedTools: ["bash", "read"], userOnly: true,
    });
  });

  test("rejects what the specification forbids", () => {
    const reject = (text: string, directory = "ok") => {
      const parsed = parseFrontmatter(text, directory);
      return Either.isLeft(parsed) ? parsed.left : "accepted";
    };
    expect(reject("# no frontmatter")).toContain("missing YAML frontmatter");
    expect(reject("---\nname: [\n---\n")).toContain("invalid YAML");
    expect(reject("---\ndescription: x\n---\n")).toContain("\"name\"");
    expect(reject("---\nname: Ok\ndescription: x\n---\n")).toContain("lowercase");
    expect(reject("---\nname: a--b\ndescription: x\n---\n", "a--b")).toContain("single hyphens");
    expect(reject(`---\nname: ${"a".repeat(65)}\ndescription: x\n---\n`)).toContain("64");
    expect(reject("---\nname: other\ndescription: x\n---\n")).toContain("does not match its directory");
    expect(reject("---\nname: ok\n---\n")).toContain("\"description\"");
    expect(reject(`---\nname: ok\ndescription: ${"d".repeat(1025)}\n---\n`)).toContain("1024");
    expect(reject("---\nname: ok\ndescription: x\nmetadata: [1]\n---\n")).toContain("metadata");
    expect(reject("---\nname: ok\ndescription: x\ndisable-model-invocation: yes please\n---\n")).toContain("boolean");
  });
});

describe("discovery", () => {
  test("earlier sources win name conflicts and every source is scanned", async () => {
    const [project, agents, user, userAgents, extra] = sources({ cwd: fixture.cwd, home: fixture.home }, { directories: [join(fixture.root, "extra")] });
    fixture.skill(project!, "shared", "name: shared\ndescription: from project");
    fixture.skill(agents!, "shared", "name: shared\ndescription: from .agents");
    fixture.skill(agents!, "agents-only", "name: agents-only\ndescription: agents");
    fixture.skill(user!, "shared", "name: shared\ndescription: from user");
    fixture.skill(user!, "user-only", "name: user-only\ndescription: user");
    fixture.skill(userAgents!, "home-agents", "name: home-agents\ndescription: home agents");
    fixture.skill(extra!, "extra-skill", "name: extra-skill\ndescription: extra");
    fixture.skill(extra!, "shared", "name: shared\ndescription: from extra");
    await run(Effect.gen(function* () {
      const core = yield* mount({ directories: [extra!] });
      const list = yield* core.run(Effect.flatMap(Skills, (s) => s.list));
      expect(list.map((s) => [s.name, s.description, s.source])).toEqual([
        ["shared", "from project", project!],
        ["agents-only", "agents", agents!],
        ["user-only", "user", user!],
        ["home-agents", "home agents", userAgents!],
        ["extra-skill", "extra", extra!],
      ]);
      expect(userAgents).toBe(join(fixture.userHome, ".agents", "skills"));
      expect(list[0]?.path).toBe(join(project!, "shared"));
      expect(notices).toEqual([]);
    }));
  });

  test("invalid skills are skipped with a notice naming the file; directories without SKILL.md are ignored", async () => {
    const project = join(fixture.cwd, ".basis", "skills");
    fixture.skill(project, "good", "name: good\ndescription: fine");
    fixture.skill(project, "renamed", "name: original\ndescription: moved", "x", "renamed");
    fixture.skill(project, "nodesc", "name: nodesc");
    mkdirSync(join(project, "not-a-skill"), { recursive: true });
    writeFileSync(join(project, "README.md"), "ignored file");
    await run(Effect.gen(function* () {
      const core = yield* mount();
      const list = yield* core.run(Effect.flatMap(Skills, (s) => s.list));
      expect(list.map((s) => s.name)).toEqual(["good"]);
      // Observers in the same composition become visible only once it is published, so
      // notices from the activation scan are lost; every later scan reports the problems again.
      yield* core.run(Effect.flatMap(Skills, (s) => s.refresh));
      yield* waitFor(Effect.sync(() => notices), (n) => n.length === 2);
      expect(notices.map((n) => n.level)).toEqual(["warning", "warning"]);
      expect(notices.map((n) => n.source)).toEqual(["skills", "skills"]);
      expect(notices.find((n) => n.message.includes(join(project, "renamed", "SKILL.md")))?.message).toContain("does not match its directory");
      expect(notices.find((n) => n.message.includes(join(project, "nodesc", "SKILL.md")))?.message).toContain("\"description\"");
    }));
  });

  test("load returns the body without frontmatter and the skill's directory; refresh sees changes on disk", async () => {
    const project = join(fixture.cwd, ".basis", "skills");
    const path = fixture.skill(project, "demo", "name: demo\ndescription: Demo skill", "# Demo\n\nRead reference.md next to this file.");
    await run(Effect.gen(function* () {
      const core = yield* mount();
      const loaded = yield* core.run(Effect.flatMap(Skills, (s) => s.load("demo")));
      expect(loaded.info.path).toBe(path);
      expect(loaded.body).toBe("# Demo\n\nRead reference.md next to this file.\n");
      const missing = yield* core.run(Effect.flatMap(Skills, (s) => s.load("nope")).pipe(Effect.flip));
      expect(missing).toMatchObject({ _tag: "SkillError", reason: "NotFound", name: "nope" });
      rmSync(path, { recursive: true });
      fixture.skill(project, "later", "name: later\ndescription: Added later");
      yield* core.run(Effect.flatMap(Skills, (s) => s.refresh));
      expect((yield* core.run(Effect.flatMap(Skills, (s) => s.list))).map((s) => s.name)).toEqual(["later"]);
    }));
  });

  test("a change on disk refreshes the list without an explicit call", async () => {
    const project = join(fixture.cwd, ".basis", "skills");
    fixture.skill(project, "first", "name: first\ndescription: First");
    await run(Effect.gen(function* () {
      const core = yield* mount();
      const list = core.run(Effect.flatMap(Skills, (s) => s.list));
      expect((yield* list).map((s) => s.name)).toEqual(["first"]);
      // A directory created after activation, then its SKILL.md: both events land on watched directories.
      mkdirSync(join(project, "second"));
      yield* Effect.sleep("30 millis");
      writeFileSync(join(project, "second", "SKILL.md"), "---\nname: second\ndescription: Second\n---\nbody\n");
      yield* waitFor(list, (skills) => skills.length === 2);
      writeFileSync(join(project, "first", "SKILL.md"), "---\nname: first\ndescription: Edited\n---\nbody\n");
      yield* waitFor(list, (skills) => skills[0]?.description === "Edited");
    }));
  });

  test("an absent config and missing directories are fine", async () => {
    await run(Effect.gen(function* () {
      const core = yield* mount();
      expect(yield* core.run(Effect.flatMap(Skills, (s) => s.list))).toEqual([]);
    }));
  });
});

describe("prompt contribution", () => {
  const preview = (system?: string) => Effect.flatMap(Hooks, (hooks) => hooks.invoke(
    AgentRequestHook,
    { sessionId: "s", request: new LlmRequest({ model: "m/x", messages: [], ...(system === undefined ? {} : { system }) }) },
    ({ request }) => Effect.succeed(request),
  ));

  test("appends a Skills section listing model-invocable skills only, and nothing when there are none", async () => {
    const project = join(fixture.cwd, ".basis", "skills");
    const path = fixture.skill(project, "deploy", "name: deploy\ndescription: Ship a release");
    fixture.skill(project, "secret", "name: secret\ndescription: For the user\ndisable-model-invocation: true");
    await run(Effect.gen(function* () {
      const core = yield* mount();
      const shaped = yield* core.run(preview("You are helpful."));
      expect(shaped.system).toBe(`You are helpful.\n\n${renderSection([{ name: "deploy", description: "Ship a release", path } as never])}`);
      expect(shaped.system).toContain(`- deploy: Ship a release (${path})`);
      expect(shaped.system).not.toContain("secret");
      expect(shaped.model).toBe("m/x");
      const bare = yield* core.run(preview());
      expect(bare.system?.startsWith("# Skills")).toBe(true);
      rmSync(path, { recursive: true });
      yield* core.run(Effect.flatMap(Skills, (s) => s.refresh));
      expect((yield* core.run(preview("Plain."))).system).toBe("Plain.");
    }));
  });
});

describe("skill tool", () => {
  test("returns the body with the directory, and an error result for unknown or user-only skills", async () => {
    const project = join(fixture.cwd, ".basis", "skills");
    const path = fixture.skill(project, "deploy", "name: deploy\ndescription: Ship a release", "Run `deploy.sh` from this directory.");
    fixture.skill(project, "secret", "name: secret\ndescription: For the user\ndisable-model-invocation: true");
    await run(Effect.gen(function* () {
      const core = yield* mount();
      const tools = yield* core.run(Effect.flatMap(Tools, (t) => t.list));
      expect(tools.map((t) => t.name)).toEqual(["skill"]);
      expect(tools[0]?.inputSchema["required"]).toEqual(["name"]);
      const execute = (input: unknown) => core.run(Effect.flatMap(Tools, (t) => t.execute(invocation("skill", input))));
      const loaded = yield* execute({ name: "deploy" });
      expect(loaded.isError).toBeUndefined();
      expect(loaded.content).toEqual([{ type: "text", text: `Skill "deploy" (directory: ${path})\n\nRun \`deploy.sh\` from this directory.\n` }]);
      const missing = yield* execute({ name: "nope" });
      expect(missing.isError).toBe(true);
      expect(missing.content[0]).toMatchObject({ type: "text", text: "No skill named \"nope\"" });
      const secret = yield* execute({ name: "secret" });
      expect(secret.isError).toBe(true);
    }));
  });
});
