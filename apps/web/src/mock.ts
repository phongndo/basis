import type { ConnectionStatus, Host } from "@lemma/client";
import { Schema } from "effect";
import { HostError, configValues, describeConfig, emptyUsage, secret } from "@lemma/contracts";
import type {
  AssistantMessage,
  EventData,
  HostEvent,
  InteractionAnswer,
  InteractionRequest,
  ModelInfo,
  PluginStatus,
  PromptContent,
  ProviderInfo,
  SessionEvent,
  SessionInfo,
  StreamEvent,
  UiComposition,
  Usage,
} from "@lemma/contracts";

/**
 * Dev-only in-browser fake of the host (`?mock`, or `?mock=fresh` for a first
 * run with no sessions). Every provider starts logged out, so the fake never
 * looks like real credentials; its login flow only pretends. Not shipped:
 * `main.tsx` imports it only in dev.
 */

const HOME = "/home/dev";
const CWD = `${HOME}/code/lemma`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let idSeq = 0;
const id = (prefix: string) => `${prefix}${(++idSeq).toString(36)}`;

const usage = (input: number, output: number, cacheRead = 0): Usage => ({
  ...emptyUsage,
  input,
  output,
  cacheRead,
  totalTokens: input + output + cacheRead,
  cost: {
    input: input * 3e-6,
    output: output * 15e-6,
    cacheRead: cacheRead * 0.3e-6,
    cacheWrite: 0,
    total: input * 3e-6 + output * 15e-6 + cacheRead * 0.3e-6,
  },
});

const assistant = (
  content: AssistantMessage["content"],
  u: Usage,
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  usage: u,
  stopReason,
  timestamp: Date.now(),
  ...(errorMessage === undefined ? {} : { errorMessage }),
});

const MODELS: ModelInfo[] = [
  {
    ref: "anthropic/claude-sonnet-4-5",
    provider: "anthropic",
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    api: "anthropic-messages",
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high"],
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 64_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    ref: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    api: "anthropic-messages",
    reasoning: false,
    thinkingLevels: [],
    input: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 64_000,
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  },
  {
    ref: "openai/gpt-5",
    provider: "openai",
    id: "gpt-5",
    name: "GPT-5",
    api: "openai-responses",
    reasoning: true,
    thinkingLevels: ["minimal", "low", "medium", "high"],
    input: ["text", "image"],
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  },
  {
    ref: "openai/gpt-5-mini",
    provider: "openai",
    id: "gpt-5-mini",
    name: "GPT-5 mini",
    api: "openai-responses",
    reasoning: true,
    thinkingLevels: ["minimal", "low", "medium", "high"],
    input: ["text"],
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  },
];

const MOCK_COMMANDS = [
  {
    id: "workspace.new-branch",
    title: "Create branch…",
    category: "Git",
    description: "Create a branch from HEAD and switch to it",
    source: "commands-workspace",
  },
  {
    id: "workspace.checkout",
    title: "Switch branch…",
    category: "Git",
    description: "Check out another branch in the working directory",
    source: "commands-workspace",
  },
  { id: "host.reload", title: "Reload config", category: "Host", description: "Re-read the config files and apply them", source: "commands-host" },
];

export const createMockHost = (): Host => {
  const fresh = new URLSearchParams(location.search).get("mock") === "fresh";
  const providers: ProviderInfo[] = [
    {
      id: "anthropic",
      name: "Anthropic",
      // As in the real llm plugin: Anthropic's subscription OAuth (Claude Pro/Max) is excluded by policy.
      auth: [{ type: "api_key", name: "API key", interactive: true }],
      configured: false,
    },
    {
      id: "openai",
      name: "OpenAI",
      auth: [
        { type: "oauth", name: "ChatGPT Plus/Pro", interactive: true },
        { type: "api_key", name: "API key", interactive: true },
      ],
      configured: false,
    },
    { id: "github-copilot", name: "GitHub Copilot", auth: [{ type: "oauth", name: "GitHub login", interactive: true }], configured: false },
    { id: "google", name: "Google Gemini", auth: [{ type: "api_key", name: "API key", interactive: true }], configured: false },
  ];
  const bundled = (id: string, extra: Partial<PluginStatus> = {}): PluginStatus => ({
    id,
    version: "0.1.0",
    source: "bundled",
    enabled: true,
    provides: [],
    requires: [],
    state: "active",
    ...extra,
  });
  const needed = "Needed by transport";
  // Mirrors of real config Schemas, so the Plugins page shows settings forms.
  const configs: Record<string, Schema.Schema.AnyNoContext> = {
    agent: Schema.Struct({
      defaultModel: Schema.optional(Schema.String).annotations({
        description: "<provider>/<model> for turns that name none. Absent: the first available model.",
      }),
      systemPrompt: Schema.optional(Schema.String).annotations({ description: "Replaces the default base prompt; the environment section is still added." }),
      maxSteps: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), { default: () => 200 }).annotations({
        description: "Model calls allowed in one turn before it ends with max-steps.",
      }),
    }),
    tools: Schema.Struct({
      maxResultChars: Schema.optionalWith(Schema.Int.pipe(Schema.positive()), { default: () => 100_000 }).annotations({
        description: "Total text characters one result may carry to the model.",
      }),
    }),
    transport: Schema.Struct({
      port: Schema.optionalWith(Schema.Number.pipe(Schema.int(), Schema.between(0, 65535)), { default: () => 7433 }).annotations({
        description: "0 asks the OS for a free port.",
      }),
      token: Schema.optional(Schema.NonEmptyString).annotations({ ...secret, description: "Generated once per host process when absent." }),
    }),
  };
  const configRows: Record<string, Record<string, unknown>> = { transport: { token: "mock-token" } };
  const withConfig = (plugin: PluginStatus): PluginStatus => {
    const schema = configs[plugin.id];
    if (schema === undefined) return plugin;
    const fields = describeConfig(schema);
    return { ...plugin, configFields: fields, config: configValues(schema, configRows[plugin.id] ?? {}, fields) };
  };
  const plugins: PluginStatus[] = [
    bundled("host", { provides: ["lemma/Paths", "lemma/HostControl"], locked: "Reads the config files and loads every other plugin" }),
    bundled("interaction", { provides: ["lemma/Interaction"], locked: needed }),
    bundled("credentials", { provides: ["lemma/Credentials"], requires: ["lemma/Paths"], locked: needed }),
    bundled("llm", { provides: ["lemma/Llm"], requires: ["lemma/Credentials", "lemma/Interaction"], locked: needed }),
    bundled("tools", { provides: ["lemma/Tools"], locked: needed }),
    bundled("read", { requires: ["lemma/Tools"] }),
    bundled("write", { requires: ["lemma/Tools"] }),
    bundled("edit", { requires: ["lemma/Tools"] }),
    bundled("bash", { requires: ["lemma/Tools"], enabled: false, state: "disabled", scope: "user" }),
    bundled("sessions", { provides: ["lemma/Sessions"], requires: ["lemma/Paths"], locked: needed }),
    bundled("agent", { provides: ["lemma/Agent"], requires: ["lemma/Sessions", "lemma/Llm", "lemma/Tools", "lemma/HostControl"], locked: needed }),
    bundled("project-context", { requires: ["lemma/Paths"] }),
    bundled("transport", {
      requires: ["lemma/Paths", "lemma/Sessions", "lemma/Agent", "lemma/Llm", "lemma/HostControl", "lemma/Workspace", "lemma/Commands"],
      locked: "Serves the web app and the CLI; replace it with another transport plugin instead of turning it off",
    }),
    bundled("my-llm", { source: "user", version: undefined, provides: ["lemma/Llm"], requires: ["lemma/Credentials"], enabled: false, state: "disabled" }),
    bundled("outline", { source: "user", version: undefined, provides: ["lemma/Outline"], requires: ["lemma/Tools"] }),
    bundled("notes", {
      source: "user",
      version: undefined,
      requires: ["lemma/Outline"],
      state: "failed",
      fault: { phase: "activate", message: 'Plugin "notes" failed during activate: ENOENT: no such file or directory, open ~/notes' },
    }),
  ];
  // Wiring as the kernel reports it, so the inspector has hooks, observers, and a fault history to show.
  const wiring: Record<string, Partial<PluginStatus>> = {
    "project-context": { hooks: [{ name: "lemma/agent.request", order: 10 }] },
    bash: { hooks: [{ name: "lemma/tool.execute", order: 0 }] },
    agent: { hooks: [{ name: "lemma/agent.request", order: 0 }] },
    transport: {
      hooks: [{ name: "lemma/interaction.request", order: 0 }],
      observes: [
        "lemma/agent.turn.started",
        "lemma/agent.turn.ended",
        "lemma/session.appended",
        "lemma/session.changed",
        "lemma/notice",
        "lemma/plugins.changed",
      ],
    },
    notes: {
      faults: [2, 1].map((sequence) => ({
        sequence,
        at: Date.now() - sequence * 90_000,
        phase: "activate",
        message: 'Plugin "notes" failed during activate: ENOENT: no such file or directory, open ~/notes',
      })),
    },
  };
  for (const [index, plugin] of plugins.entries()) plugins[index] = withConfig({ ...plugin, ...wiring[plugin.id] });
  let ui: UiComposition = { plugins: {}, enabledIn: {}, configIn: {}, files: [] };
  // Like the host: an enabled provider wins over a disabled one with the same capability.
  const providerOf = (key: string) =>
    plugins.find((plugin) => plugin.enabled && plugin.provides.includes(key)) ?? plugins.find((plugin) => plugin.provides.includes(key));
  const halted = () => {
    for (const plugin of plugins) {
      if (!plugin.enabled) continue;
      const missing = plugin.requires.map(providerOf).find((provider) => provider !== undefined && provider.state === "disabled");
      if (missing !== undefined) plugins[plugins.indexOf(plugin)] = { ...plugin, state: "disabled", haltedBy: missing.id };
      else if (plugin.state === "disabled") plugins[plugins.indexOf(plugin)] = { ...plugin, state: "active", haltedBy: undefined };
    }
  };
  const sessions = new Map<string, { info: SessionInfo; events: SessionEvent[] }>();
  const listeners = new Set<(event: HostEvent) => void>();
  const emit = (event: HostEvent) => {
    for (const listener of listeners) listener(event);
  };
  const pendingAnswers = new Map<string, (answer: InteractionAnswer | undefined) => void>();
  const openRequests = new Map<string, InteractionRequest>();
  const cancelled = new Set<string>();
  const running = new Set<string>();

  const create = (cwd = CWD, at = Date.now()): SessionInfo => {
    const info: SessionInfo = { id: id("s"), cwd, createdAt: at, updatedAt: at, lastSeq: 0 };
    sessions.set(info.id, { info, events: [] });
    return info;
  };
  const append = (sessionId: string, data: EventData, at = Date.now(), quiet = false): SessionEvent => {
    const session = sessions.get(sessionId)!;
    const event: SessionEvent = { seq: session.events.length + 1, id: id("e"), parent: session.info.leaf ?? null, at, data };
    session.events.push(event);
    session.info = {
      ...session.info,
      leaf: event.id,
      lastSeq: event.seq,
      updatedAt: at,
      ...(data.type === "title" ? { title: data.title } : {}),
    };
    if (!quiet) {
      emit({ type: "session-appended", sessionId, event });
      emit({ type: "session-changed", info: session.info });
    }
    return event;
  };

  // Seed history.
  if (!fresh) {
    const t0 = Date.now() - 3 * 3600_000;
    const s = create(CWD, t0).id;
    let t = t0;
    const at = (ms = 400) => (t += ms);
    append(s, { type: "title", title: "Fix flaky session log test" }, at(), true);
    append(s, { type: "turn-start", turnId: "t1" }, at(), true);
    append(
      s,
      {
        type: "message",
        turnId: "t1",
        message: {
          role: "user",
          timestamp: t,
          content: [{ type: "text", text: "The session-log test fails randomly on CI. Can you find out why and fix it?" }],
        },
      },
      at(),
      true,
    );
    append(s, { type: "step-start", turnId: "t1", stepId: "p1" }, at(), true);
    append(
      s,
      {
        type: "attempt",
        turnId: "t1",
        stepId: "p1",
        message: assistant([], usage(0, 0), "error", "529 overloaded_error: Overloaded"),
        timing: { startedAt: t, endedAt: at(900) },
      },
      t,
      true,
    );
    const callA = { type: "toolCall" as const, id: "c1", name: "bash", arguments: { command: "pnpm --filter @lemma/client test -- --reporter=dot" } };
    const callB = {
      type: "toolCall" as const,
      id: "c2",
      name: "read",
      arguments: { path: `${CWD}/packages/client/tests/session-log.test.ts`, offset: 30, limit: 40 },
    };
    append(
      s,
      {
        type: "message",
        turnId: "t1",
        stepId: "p1",
        timing: { startedAt: t, firstTokenAt: t + 700, endedAt: at(3200) },
        message: assistant(
          [
            {
              type: "thinking",
              thinking:
                "The test uses setTimeout(0) to wait for the repair fetch. If the fetch resolves later than a macrotask, the assertion races.\nLet me run it and look at the test.",
            },
            { type: "text", text: "Let me run the tests and look at the file." },
            callA,
            callB,
          ],
          usage(4200, 180, 12000),
          "toolUse",
        ),
      },
      t,
      true,
    );
    append(
      s,
      {
        type: "message",
        turnId: "t1",
        stepId: "p1",
        timing: { startedAt: t, endedAt: at(2400) },
        details: { exitCode: 1 },
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "bash",
          isError: true,
          timestamp: t,
          content: [
            {
              type: "text",
              text: " ✓ mergeEvents (3)\n ✓ rpcUrl (1)\n × SessionLog > holds events beyond a gap\n   AssertionError: expected [ 1, 2 ] to deeply equal [ 1, 2, 3, 4, 5 ]\n\n Test Files  1 failed (1)\n      Tests  1 failed | 11 passed (12)",
            },
          ],
        },
      },
      t,
      true,
    );
    append(
      s,
      {
        type: "message",
        turnId: "t1",
        stepId: "p1",
        timing: { startedAt: t, endedAt: at(40) },
        message: {
          role: "toolResult",
          toolCallId: "c2",
          toolName: "read",
          isError: false,
          timestamp: t,
          content: [{ type: "text", text: '  it("holds events beyond a gap", async () => {\n    const file = range(1, 2);\n    ...\n    await settle();\n' }],
        },
      },
      t,
      true,
    );
    append(s, { type: "step-end", turnId: "t1", stepId: "p1" }, at(), true);
    const callC = {
      type: "toolCall" as const,
      id: "c3",
      name: "edit",
      arguments: {
        path: `${CWD}/packages/client/tests/session-log.test.ts`,
        oldText: "await settle();",
        newText: "await vi.waitFor(() => expect(s.calls).toHaveLength(2));",
      },
    };
    append(
      s,
      {
        type: "message",
        turnId: "t1",
        stepId: "p2",
        timing: { startedAt: t, firstTokenAt: t + 500, endedAt: at(2600) },
        message: assistant(
          [
            {
              type: "text",
              text: "The repair fetch is awaited with a single `setTimeout(0)`, which races when the fake fetch takes more than one macrotask. I'll wait for the call instead:",
            },
            callC,
          ],
          usage(5100, 240, 16200),
          "toolUse",
        ),
      },
      t,
      true,
    );
    append(
      s,
      {
        type: "message",
        turnId: "t1",
        stepId: "p2",
        timing: { startedAt: t, endedAt: at(30) },
        details: {
          diff: "--- a/packages/client/tests/session-log.test.ts\n+++ b/packages/client/tests/session-log.test.ts\n@@ -88,7 +88,7 @@\n     log.apply(ev(5));\n     expect(seqs(log.events)).toEqual([1, 2]);\n-    await settle();\n+    await vi.waitFor(() => expect(s.calls).toHaveLength(2));\n     expect(s.calls).toEqual([undefined, 2]);\n",
        },
        message: {
          role: "toolResult",
          toolCallId: "c3",
          toolName: "edit",
          isError: false,
          timestamp: t,
          content: [{ type: "text", text: "Edited packages/client/tests/session-log.test.ts" }],
        },
      },
      t,
      true,
    );
    append(
      s,
      {
        type: "message",
        turnId: "t1",
        stepId: "p3",
        timing: { startedAt: t, firstTokenAt: t + 400, endedAt: at(1800) },
        message: assistant(
          [
            {
              type: "text",
              text: "Fixed. The test now waits for the repair fetch explicitly:\n\n```ts\nawait vi.waitFor(() => expect(s.calls).toHaveLength(2));\n```\n\n- **Cause:** a timing assumption (`setTimeout(0)`) in the test, not a bug in `SessionLog`.\n- **Check:** ran the suite 50× locally with no failures.",
            },
          ],
          usage(5600, 120, 21000),
        ),
      },
      t,
      true,
    );
    append(s, { type: "turn-end", turnId: "t1", reason: "done" }, at(100), true);

    const s2 = create(`${HOME}/code/website`, t0 - 86400_000 * 2).id;
    append(s2, { type: "title", title: "Landing page copy" }, t0 - 86400_000 * 2, true);
    create(CWD, t0 - 86400_000);
  }

  const status: ConnectionStatus = { state: "connected", generation: 1, attempts: 0 };

  const stream = async (sessionId: string, turnId: string, stepId: string, message: AssistantMessage) => {
    emit({ type: "delta", sessionId, turnId, stepId, event: { type: "start" } });
    for (const [index, part] of message.content.entries()) {
      if (cancelled.has(sessionId)) return false;
      if (part.type === "text" || part.type === "thinking") {
        const text = part.type === "text" ? part.text : part.thinking;
        for (let i = 0; i < text.length; i += 6) {
          if (cancelled.has(sessionId)) return false;
          const delta = text.slice(i, i + 6);
          const event: StreamEvent = part.type === "text" ? { type: "text-delta", index, delta } : { type: "thinking-delta", index, delta };
          emit({ type: "delta", sessionId, turnId, stepId, event });
          await sleep(18);
        }
      } else if (part.type === "toolCall") {
        emit({ type: "delta", sessionId, turnId, stepId, event: { type: "toolcall-start", index, id: part.id, name: part.name } });
        const json = JSON.stringify(part.arguments);
        for (let i = 0; i < json.length; i += 8) {
          emit({ type: "delta", sessionId, turnId, stepId, event: { type: "toolcall-delta", index, delta: json.slice(i, i + 8) } });
          await sleep(15);
        }
        emit({ type: "delta", sessionId, turnId, stepId, event: { type: "toolcall-end", index, toolCall: part } });
      }
    }
    emit({ type: "delta", sessionId, turnId, stepId, event: { type: "done", message } });
    return true;
  };

  const runTurn = async (sessionId: string, content: PromptContent) => {
    const turnId = id("t");
    const started = Date.now();
    append(sessionId, { type: "turn-start", turnId });
    append(sessionId, { type: "message", turnId, message: { role: "user", content, timestamp: started } });
    emit({ type: "turn-started", sessionId, turnId });
    running.add(sessionId);
    const text = content.find((part) => part.type === "text")?.text ?? "(image)";
    let total = emptyUsage;
    const end = (reason: "done" | "cancelled") => {
      append(sessionId, { type: "turn-end", turnId, reason });
      emit({ type: "turn-ended", sessionId, turnId, usage: total, reason });
      running.delete(sessionId);
      cancelled.delete(sessionId);
    };
    const step1 = id("p");
    const startedAt = Date.now();
    const call = { type: "toolCall" as const, id: id("c"), name: "bash", arguments: { command: "ls -la packages" } };
    const m1 = assistant(
      [
        { type: "thinking", thinking: `The user said: "${text.slice(0, 60)}". I'll look around the repo first.` },
        { type: "text", text: "Let me look at the workspace layout first." },
        call,
      ],
      usage(3000, 90, 8000),
      "toolUse",
    );
    if (!(await stream(sessionId, turnId, step1, m1))) return end("cancelled");
    total = m1.usage;
    append(sessionId, { type: "message", turnId, stepId: step1, message: m1, timing: { startedAt, firstTokenAt: startedAt + 300, endedAt: Date.now() } });
    await sleep(900);
    if (cancelled.has(sessionId)) return end("cancelled");
    append(sessionId, {
      type: "message",
      turnId,
      stepId: step1,
      details: { exitCode: 0 },
      timing: { startedAt: Date.now() - 900, endedAt: Date.now() },
      message: {
        role: "toolResult",
        toolCallId: call.id,
        toolName: "bash",
        isError: false,
        timestamp: Date.now(),
        content: [{ type: "text", text: "drwxr-xr-x client\ndrwxr-xr-x contracts\ndrwxr-xr-x core" }],
      },
    });
    const step2 = id("p");
    const s2 = Date.now();
    const m2 = assistant(
      [
        {
          type: "text",
          text: `There are three packages: **client**, **contracts**, and **core**.\n\nYou asked: _${text.slice(0, 120)}_ — this is the mock host, so that's as far as I go. Try:\n\n1. The model picker (Ctrl+K)\n2. Esc to stop a turn\n3. Settings → Providers for the login flow`,
        },
      ],
      usage(3300, 110, 11000),
    );
    if (!(await stream(sessionId, turnId, step2, m2))) return end("cancelled");
    total = { ...total, input: total.input + m2.usage.input, output: total.output + m2.usage.output };
    append(sessionId, { type: "message", turnId, stepId: step2, message: m2, timing: { startedAt: s2, firstTokenAt: s2 + 250, endedAt: Date.now() } });
    end("done");
    const info = sessions.get(sessionId)!.info;
    if (info.title === undefined) append(sessionId, { type: "title", title: text.slice(0, 48) });
  };

  const ask = (request: Parameters<typeof emit>[0] & { type: "interaction" }) =>
    new Promise<InteractionAnswer | undefined>((resolve) => {
      pendingAnswers.set(request.request.id, resolve);
      openRequests.set(request.request.id, request.request);
      emit(request);
    });

  const mockBranches = ["main", "harness", "composer-polish", "origin/release"];
  let currentBranch = "harness";
  const workspaceStatus = (path: string) => ({
    path,
    exists: true,
    git: { root: path, branch: currentBranch, head: "84c3bfc", changes: 3, upstream: `origin/${currentBranch}`, ahead: 1, behind: 0 },
  });

  const notFound = (sessionId: string) => new Error(`Session ${sessionId} not found`);

  return {
    session: {
      list: async () => [...sessions.values()].map((s) => s.info).sort((a, b) => b.updatedAt - a.updatedAt),
      get: async (sessionId) => {
        const s = sessions.get(sessionId);
        if (!s) throw notFound(sessionId);
        return s.info;
      },
      create: async (cwd) => {
        const info = create(cwd);
        emit({ type: "session-changed", info });
        return info;
      },
      events: async (sessionId, after) => {
        await sleep(120);
        const s = sessions.get(sessionId);
        if (!s) throw notFound(sessionId);
        return s.events.filter((e) => e.seq > (after ?? 0));
      },
      checkout: async (sessionId) => sessions.get(sessionId)!.info,
      setTitle: async (sessionId, title) => {
        append(sessionId, { type: "title", title });
        return sessions.get(sessionId)!.info;
      },
    },
    agent: {
      prompt: async (sessionId, content) => {
        if (running.has(sessionId)) throw new Error("A turn is already running");
        await runTurn(sessionId, content);
      },
      cancel: async (sessionId) => {
        if (running.has(sessionId)) cancelled.add(sessionId);
      },
      running: async () => [...running],
    },
    llm: {
      providers: async () => providers.slice(),
      models: async () => MODELS.filter((model) => providers.find((p) => p.id === model.provider)?.configured),
      login: async (provider, type) => {
        const p = providers.find((x) => x.id === provider)!;
        if (type === "api_key") {
          const answer = await ask({
            type: "interaction",
            request: { type: "ask", id: id("i"), title: `${p.name} API key`, placeholder: "sk-…", secret: true },
          });
          if (answer === undefined || answer.type !== "ask" || answer.value === "") throw new Error("Login cancelled");
        } else {
          const answer = await ask({
            type: "interaction",
            request: {
              type: "select",
              id: id("i"),
              title: `Log in to ${p.name}`,
              options: [
                { value: "browser", label: "Open browser", description: "Sign in on the provider's site" },
                { value: "device", label: "Device code", description: "Enter a code on another device" },
              ],
            },
          });
          if (answer === undefined) throw new Error("Login cancelled");
          emit({
            type: "notice",
            notice: {
              level: "info",
              source: "lemma/llm-pi-ai",
              message: `Enter this code to finish logging in to ${p.name}`,
              code: "WDJB-MJHT",
              links: [{ url: "https://github.com/login/device", label: "Open login page" }],
            },
          });
          await sleep(4000);
        }
        const i = providers.indexOf(p);
        providers[i] = { ...p, configured: true, source: type === "oauth" ? "OAuth" : "auth.json" };
        emit({ type: "notice", notice: { level: "info", source: "llm", message: `Logged in to ${p.name}` } });
      },
      logout: async (provider) => {
        const i = providers.findIndex((x) => x.id === provider);
        const { source: _source, ...rest } = providers[i]!;
        providers[i] = { ...rest, configured: false };
      },
    },
    workspace: {
      status: async (path) => workspaceStatus(path),
      browse: async (partialPath) => {
        const parent = partialPath.endsWith("/") ? partialPath.replace(/\/+$/, "") || "/" : partialPath.slice(0, partialPath.lastIndexOf("/")) || "/";
        const needle = partialPath.endsWith("/") ? "" : partialPath.slice(partialPath.lastIndexOf("/") + 1).toLowerCase();
        const names = ["lemma", "dotfiles", "nix-config", "notes", "pi-extensions", "tau"];
        const entries = names
          .filter((name) => name.includes(needle))
          .map((name) => ({
            name,
            path: `${parent}/${name}`,
            git: name !== "notes",
            matches: needle === "" ? [] : Array.from({ length: needle.length }, (_, i) => name.indexOf(needle) + i),
          }));
        return { parent, entries, truncated: false };
      },
      createDirectory: async (path) => ({ path, exists: true }),
      createWorktree: async (path, options) => {
        await sleep(300);
        const tree = `${HOME}/worktrees/${path.split("/").pop()}/${options.branch.replace(/\//g, "-")}`;
        return { path: tree, exists: true, git: { root: tree, branch: options.branch, head: "84c3bfc", changes: 0, ahead: 0, behind: 0, worktreeOf: path } };
      },
      branches: async () =>
        mockBranches.map((name, index) => ({
          name,
          current: name === currentBranch,
          remote: name.startsWith("origin/"),
          updatedAt: Date.now() - index * 3_600_000,
        })),
      checkout: async (path, branch, options) => {
        await sleep(250);
        const name = branch.replace(/^origin\//, "");
        if (options?.create === true || !mockBranches.includes(name)) mockBranches.unshift(name);
        currentBranch = name;
        return workspaceStatus(path);
      },
    },
    interaction: {
      list: async () => [...openRequests.values()],
      answer: async (interactionId, answer) => {
        pendingAnswers.get(interactionId)?.(answer);
        pendingAnswers.delete(interactionId);
        openRequests.delete(interactionId);
        emit({ type: "interaction-closed", id: interactionId });
      },
      dismiss: async (interactionId) => {
        pendingAnswers.get(interactionId)?.(undefined);
        pendingAnswers.delete(interactionId);
        openRequests.delete(interactionId);
        emit({ type: "interaction-closed", id: interactionId });
      },
    },
    commands: {
      list: async () => MOCK_COMMANDS.slice(),
      run: async (commandId) => {
        const cancelled = () => new HostError({ code: "Cancelled", message: "Cancelled", subject: commandId });
        switch (commandId) {
          case "host.reload":
            await sleep(400);
            return { message: "Config reloaded: restarted lemma/agent" };
          case "workspace.checkout": {
            const answer = await ask({
              type: "interaction",
              request: {
                type: "select",
                id: id("i"),
                title: "Switch to which branch?",
                options: mockBranches.filter((name) => name !== currentBranch).map((name) => ({ value: name, label: name })),
              },
            });
            if (answer?.type !== "select") throw cancelled();
            await sleep(250);
            currentBranch = answer.value.replace(/^origin\//, "");
            return { message: `Switched to ${currentBranch}` };
          }
          case "workspace.new-branch": {
            const answer = await ask({ type: "interaction", request: { type: "ask", id: id("i"), title: "New branch name", placeholder: "feature/name" } });
            if (answer?.type !== "ask") throw cancelled();
            mockBranches.unshift(answer.value);
            currentBranch = answer.value;
            return { message: `Created and switched to ${answer.value}` };
          }
          default:
            throw new HostError({ code: "NotFound", message: `No command "${commandId}"`, subject: commandId });
        }
      },
    },
    host: {
      info: async () => ({
        version: "0.1.0-mock",
        cwd: CWD,
        home: HOME,
        composition: { id: "c0ffee1234abcd", plugins: plugins.map((p) => ({ id: p.id, ...(p.version === undefined ? {} : { version: p.version }) })) },
      }),
      plugins: async () => plugins.slice(),
      restartPlugin: async (pluginId) => {
        await sleep(600);
        const i = plugins.findIndex((p) => p.id === pluginId);
        plugins[i] = { ...plugins[i]!, state: "active", fault: undefined, haltedBy: undefined };
        emit({ type: "plugins-changed", plugins: plugins.slice() });
      },
      reload: async () => {
        await sleep(400);
        return { started: [], restarted: ["agent"], stopped: [] };
      },
      configure: async (rows, options) => {
        await sleep(500);
        const before = plugins.filter((plugin) => plugin.state !== "disabled").map((plugin) => plugin.id);
        for (const [id, row] of Object.entries(rows)) {
          const i = plugins.findIndex((p) => p.id === id);
          if (i < 0) throw new HostError({ code: "ReloadError", message: `error [${id}]: No plugin "${id}"`, subject: id });
          if (plugins[i]!.locked !== undefined && row.enabled === false) {
            throw new HostError({ code: "ReloadError", message: `error [${id}]: "${id}" cannot be turned off: ${plugins[i]!.locked}`, subject: id });
          }
          if (row.values !== undefined) {
            const next = { ...configRows[id] };
            for (const [key, value] of Object.entries(row.values)) {
              if (value === null) delete next[key];
              else next[key] = value;
            }
            configRows[id] = next;
            plugins[i] = withConfig(plugins[i]!);
            // Like the host: the transport needs every configurable plugin here, so the change applies after the reply.
            setTimeout(() => emit({ type: "plugins-changed", plugins: plugins.slice() }), 300);
            return { started: [], restarted: [], stopped: [], deferred: true };
          }
          if (row.enabled === undefined) continue;
          if (row.enabled) {
            for (const other of plugins) {
              if (other.id !== id && other.enabled && other.provides.some((key) => plugins[i]!.provides.includes(key))) {
                plugins[plugins.indexOf(other)] = { ...other, enabled: false, state: "disabled", scope: options?.scope ?? "user" };
              }
            }
          }
          plugins[i] = {
            ...plugins[i]!,
            enabled: row.enabled,
            state: row.enabled ? "active" : "disabled",
            scope: row.enabled ? undefined : (options?.scope ?? "user"),
          };
        }
        halted();
        emit({ type: "plugins-changed", plugins: plugins.slice() });
        const after = plugins.filter((plugin) => plugin.state !== "disabled").map((plugin) => plugin.id);
        return { started: after.filter((id) => !before.includes(id)), restarted: [], stopped: before.filter((id) => !after.includes(id)) };
      },
    },
    ui: {
      composition: async () => ui,
      configure: async (rows, options) => {
        await sleep(200);
        const plugins = { ...ui.plugins };
        const enabledIn = { ...ui.enabledIn };
        const configIn = { ...ui.configIn };
        const scope = options?.scope ?? "user";
        for (const [id, row] of Object.entries(rows)) {
          const next: { enabled?: boolean; config?: Record<string, unknown> } = { ...(plugins[id] as { enabled?: boolean; config?: Record<string, unknown> }) };
          if (row.enabled !== undefined) {
            if (row.enabled) delete next.enabled;
            else next.enabled = false;
            if (row.enabled) delete enabledIn[id];
            else enabledIn[id] = scope;
          }
          if (row.values !== undefined) {
            const config = { ...next.config };
            for (const [key, value] of Object.entries(row.values)) {
              if (value === null) delete config[key];
              else config[key] = value;
            }
            if (Object.keys(config).length === 0) delete next.config;
            else next.config = config;
            if (next.config === undefined) delete configIn[id];
            else configIn[id] = scope;
          }
          if (Object.keys(next).length === 0) delete plugins[id];
          else plugins[id] = next;
        }
        ui = { ...ui, plugins, enabledIn, configIn };
        emit({ type: "ui-changed", ui });
        return ui;
      },
    },
    status: () => status,
    onStatus: (listener) => {
      listener(status);
      return () => {};
    },
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: async () => {},
  };
};
