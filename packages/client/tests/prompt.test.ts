import { describe, expect, test } from "vitest";
import type { HostEvent } from "@basis/contracts";
import { startPrompt } from "../src/prompt.ts";

const fakeHost = () => {
  const listeners = new Set<(event: HostEvent) => void>();
  let settle: { resolve: () => void; reject: (error: Error) => void } | undefined;
  return {
    host: {
      agent: {
        prompt: () =>
          new Promise<void>((resolve, reject) => {
            settle = { resolve, reject };
          }),
        cancel: async () => {},
        running: async () => [],
      },
      onEvent: (listener: (event: HostEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    emit: (event: HostEvent) => {
      for (const listener of listeners) listener(event);
    },
    listeners,
    settle: () => settle!,
  };
};

const state = (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 5)),
  ]);

describe("startPrompt", () => {
  test("is accepted when its session's turn starts, long before the turn ends", async () => {
    const fake = fakeHost();
    const started = startPrompt(fake.host, "s1", [{ type: "text", text: "hi" }]);
    fake.emit({ type: "turn-started", sessionId: "other", turnId: "t0" });
    expect(await state(started.accepted)).toBe("pending");
    fake.emit({ type: "turn-started", sessionId: "s1", turnId: "t1" });
    expect(await state(started.accepted)).toBe("resolved");
    expect(await state(started.done)).toBe("pending");
    expect(fake.listeners.size).toBe(0);
  });

  test("a refused prompt rejects acceptance, so the caller keeps its input", async () => {
    const fake = fakeHost();
    const started = startPrompt(fake.host, "s1", [{ type: "text", text: "hi" }]);
    fake.settle().reject(new Error("Session s1 already has a turn in progress"));
    await expect(started.accepted).rejects.toThrow("already has a turn");
    await expect(started.done).rejects.toThrow();
    expect(fake.listeners.size).toBe(0);
  });

  test("a turn that ends without a seen turn-started still counts as accepted", async () => {
    const fake = fakeHost();
    const started = startPrompt(fake.host, "s1", [{ type: "text", text: "hi" }]);
    fake.settle().resolve();
    expect(await state(started.accepted)).toBe("resolved");
  });
});
