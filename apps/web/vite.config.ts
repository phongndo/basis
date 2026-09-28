/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Production: the host's transport plugin serves `dist` and `/rpc` from the same origin.
export default defineConfig({
  plugins: [solid()],
  resolve: { conditions: ["source"] },
  server: {
    host: "127.0.0.1",
    proxy: { "/rpc": { target: "http://127.0.0.1:7433", ws: true } },
  },
  build: { target: "es2022", sourcemap: true },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
