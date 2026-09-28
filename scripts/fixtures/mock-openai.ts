import { createServer } from "node:http";

/**
 * A scripted OpenAI Chat Completions server for end-to-end runs without an API
 * key. A user turn gets a `bash` tool call; a tool result gets a streamed text
 * answer that quotes it. Configure it as a keyless custom provider:
 *
 *   { "plugins": { "llm": { "config": { "providers": [{ "id": "mock", "api": "openai-completions",
 *     "baseUrl": "http://127.0.0.1:7499/v1", "models": [{ "id": "scripted" }] }] } } } }
 */
const port = Number(process.env.PORT ?? 7499);

interface ChatMessage { readonly role: string; readonly content?: unknown }

const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  request.on("data", (data) => { body += data; });
  request.on("end", async () => {
    const messages: ChatMessage[] = JSON.parse(body).messages;
    const last = messages.at(-1);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (text: string) => response.write(text);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 40));
    if (last?.role === "tool") {
      const output = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
      const words = `The command printed: **${output.trim()}**. Everything works end to end.`.split(/(?<= )/);
      for (const word of words) { send(chunk({ content: word })); await pause(); }
      send(chunk({}, "stop"));
    } else {
      send(chunk({ content: "Let me check with bash." }));
      await pause();
      send(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] }));
      send(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: "echo hello from basis && uname -s" }) } }] }));
      send(chunk({}, "tool_calls"));
    }
    send(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [], usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 } })}\n\n`);
    send("data: [DONE]\n\n");
    response.end();
  });
}).listen(port, "127.0.0.1", () => console.log(`mock-openai listening on http://127.0.0.1:${port}/v1`));
