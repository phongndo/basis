import { render } from "solid-js/web";
import { connect, describeError } from "@basis/client";
import type { Host } from "@basis/client";
import { App } from "./app.tsx";
import { installCodeCopy } from "./components/markdown.tsx";
import { takeToken } from "./lib/token.ts";
import { attach, reportError } from "./store.ts";
import "./styles.css";

const start = async () => {
  const token = takeToken();
  let host: Host;
  // `?mock` in dev runs against an in-browser fake host (no backend needed).
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
    const { createMockHost } = await import("./mock.ts");
    host = createMockHost();
  } else {
    host = await connect({ url: location.href, token });
  }
  attach(host);
};

installCodeCopy();
render(() => <App />, document.getElementById("root")!);
start().catch((error) => reportError(new Error(describeError(error)), "Could not start"));
