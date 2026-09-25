import { readFileSync } from "node:fs";
import { Cause, Chunk, Effect, Exit, Option, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "@effect/platform";
import type { HttpBody, HttpClientRequest } from "@effect/platform";
import { LlmError } from "@basis/contracts";
import type { StreamEvent } from "@basis/contracts";
import { parseSse, toStreamEvents } from "../src/index.ts";

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}.sse`, import.meta.url)));
}

/** Small fixed chunks so every line and event boundary is crossed mid-way at least once. */
export function chunked(bytes: Uint8Array, size = 7): Stream.Stream<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) chunks.push(bytes.slice(offset, offset + size));
  return Stream.fromIterable(chunks);
}

export const mapped = (name: string): Effect.Effect<readonly StreamEvent[], LlmError> =>
  Stream.runCollect(chunked(fixture(name)).pipe(parseSse, toStreamEvents)).pipe(Effect.map(Chunk.toArray));

export function llmFailure(exit: Exit.Exit<unknown, unknown>): LlmError {
  if (Exit.isSuccess(exit)) throw new Error("Expected failure");
  const error = Option.getOrThrow(Cause.failureOption(exit.cause));
  if (!(error instanceof LlmError)) throw new Error(`Expected LlmError, got ${String(error)}`);
  return error;
}

export interface Captured { readonly url: string; readonly headers: Record<string, string>; readonly body: unknown }

/** An HttpClient that answers with a canned Response and records what was sent. */
export function fakeClient(respond: (captured: Captured) => Response): { readonly client: HttpClient.HttpClient; readonly requests: Captured[] } {
  const requests: Captured[] = [];
  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
    const body = request.body as HttpBody.HttpBody;
    const captured: Captured = {
      url: request.url,
      headers: { ...request.headers },
      body: body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(body.body)) : undefined,
    };
    requests.push(captured);
    return Effect.succeed(HttpClientResponse.fromWeb(request, respond(captured)));
  });
  return { client, requests };
}

export const sseResponse = (name: string, status = 200) =>
  new Response(fixture(name), { status, headers: { "content-type": "text/event-stream" } });
