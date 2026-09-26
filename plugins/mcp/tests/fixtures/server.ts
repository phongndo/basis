// A small MCP server over stdio for the tests; spawned as a Bun subprocess.
// `--crash` exits with a message on stderr before serving.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (process.argv.includes("--crash")) {
  process.stderr.write("fixture: refusing to start\n");
  process.exit(1);
}

const server = new McpServer({ name: "fixture", version: "1.0.0" });
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

server.registerTool("echo", { description: "Echo the text back", inputSchema: { text: z.string().describe("What to echo") } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }));
server.registerTool("picture", { description: "Return a one-pixel image" },
  async () => ({ content: [{ type: "text", text: "a pixel" }, { type: "image", data: PIXEL, mimeType: "image/png" }] }));
server.registerTool("fail", { description: "Always reports a tool error" },
  async () => ({ content: [{ type: "text", text: "boom" }], isError: true }));
server.registerTool("add_tool", { description: "Register another echo-like tool at runtime", inputSchema: { name: z.string() } },
  async ({ name }) => {
    server.registerTool(name, { description: `Dynamic tool ${name}`, inputSchema: { value: z.number() } },
      async ({ value }) => ({ content: [{ type: "text", text: `${name}: ${value}` }] }));
    return { content: [{ type: "text", text: `added ${name}` }] };
  });
server.registerTool("quit", { description: "Exit the server process" }, async () => {
  setTimeout(() => process.exit(0), 20);
  return { content: [{ type: "text", text: "bye" }] };
});

await server.connect(new StdioServerTransport());
