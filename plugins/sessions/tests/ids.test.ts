import { describe, expect, it, vi } from "vitest";

// 0xf8 encodes as `-` in base64url; the second draw is all zeros, `A…`.
const draws = [Buffer.alloc(9, 0xf8), Buffer.alloc(9, 0)];
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomBytes: (size: number) => draws.shift()!.subarray(0, size),
}));

const { sessionId } = await import("../src/format.ts");

describe("sessionId", () => {
  it("never starts with -, which a command line would take for an option", () => {
    expect(sessionId()).toBe("AAAAAAAAAAAA");
  });
});
