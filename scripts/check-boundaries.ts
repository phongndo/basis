import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The kernel stays domain-neutral: `packages/core` may depend on Effect only
// and may import nothing from the harness packages in this workspace.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = join(root, "packages/core");
const problems: string[] = [];

const manifest = JSON.parse(readFileSync(join(core, "package.json"), "utf8"));
for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
  if (name !== "effect") problems.push(`packages/core/package.json: runtime dependency "${name}" (only effect is allowed)`);
}

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === "node_modules" || name === "dist" ? [] : walk(path)) : [path];
  });
const importPattern = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
for (const file of walk(core).filter((path) => /\.(ts|tsx|mts)$/.test(path))) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1]!;
    const escapes = specifier.startsWith(".") && !resolve(dirname(file), specifier).startsWith(core);
    if ((specifier.startsWith("@basis/") && specifier !== "@basis/core") || escapes) {
      problems.push(`${relative(root, file)}: imports "${specifier}"`);
    }
  }
}

if (problems.length) {
  console.error(`Kernel boundary violations:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  process.exit(1);
}
console.log("kernel boundary: ok");
