import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The kernel stays domain-neutral: `packages/core` may depend on Effect only,
// may import nothing from the harness packages in this workspace, and names
// none of the harness's concepts.
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
    if ((specifier.startsWith("@lemma/") && specifier !== "@lemma/core") || escapes) {
      problems.push(`${relative(root, file)}: imports "${specifier}"`);
    }
  }
}

// It stays domain-neutral in its words too: the harness's concepts belong to its contracts and plugins.
const harnessWords = /\b(tools?|agents?|sessions?|llms?|prompts?|transcripts?|chats?|models?|slots?|harness)\b/i;
for (const file of walk(join(core, "src")).filter((path) => /\.(ts|tsx|mts)$/.test(path))) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      const word = harnessWords.exec(line)?.[1];
      if (word !== undefined) problems.push(`${relative(root, file)}:${index + 1}: names "${word}", a harness concept`);
    });
}

if (problems.length) {
  console.error(`Kernel boundary violations:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  process.exit(1);
}
console.log("kernel boundary: ok");
