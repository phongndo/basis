// Manual smoke: drives a running host through the real client. Usage: node e2e-smoke.ts <url> <token>
import { connect } from "@basis/client";
import { branchOf, rebuildRequest } from "@basis/contracts";
const [url, token] = process.argv.slice(2);
const host = await connect({ url: url!, token });
const seen: string[] = [];
host.onEvent((event) => { seen.push(event.type); });
await new Promise((resolve) => setTimeout(resolve, 500));
console.log("info", JSON.stringify((await host.host.info()).composition.plugins.map((p) => p.id)));
console.log("models", (await host.llm.models(true)).map((m) => m.ref).join(", "));
console.log("providers configured", (await host.llm.providers()).filter((p) => p.configured).map((p) => `${p.id}(${p.source})`).join(", "));
const session = await host.session.create("/tmp/e2e");
await host.agent.prompt(session.id, [{ type: "text", text: "Say hello using bash" }]);
const events = await host.session.events(session.id);
console.log("events", events.map((e) => e.data.type + (e.data.type === "message" ? `:${e.data.message.role}` : "")).join(" "));
const branch = branchOf(events, (await host.session.get(session.id)).leaf);
for (const request of branch.filter((e) => e.data.type === "request")) {
  const data = request.data as Extract<typeof request.data, { type: "request" }>;
  console.log("request", request.id, data.model, "system?", data.system !== undefined, "tools?", data.tools?.map((t) => t.name).join("/"), "contrib", data.contributions.map((c) => `${c.source}:${c.label}`).join(","));
  console.log("  rebuilt messages:", rebuildRequest(branch, request.id)!.messages.length);
}
const final = events.filter((e) => e.data.type === "message").at(-1)!;
console.log("final", JSON.stringify(final.data).slice(0, 400));
console.log("live event kinds", [...new Set(seen)].join(", "));
console.log("title", (await host.session.get(session.id)).title);
await host.close();
process.exit(0);
