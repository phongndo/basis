import { defineConfig } from "vitest/config";

// Resolve workspace packages from source, as the Node runtime does with --conditions=source.
export default defineConfig({ resolve: { conditions: ["source"] } });
