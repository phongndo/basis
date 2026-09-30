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

// The web app is replaceable piece by piece: everything it shows comes from a
// plugin (turn it off or replace it by id), and plugins reach each other only
// through `ui/contracts.ts` (capabilities, slots, parts). So a plugin imports
// no other plugin and no rendering component: it draws shared pieces through
// `ui/parts.tsx`, whose providers anyone can replace. Only `kit` supplies the
// shared parts' defaults, so only it imports `components/`. See apps/web/AGENTS.md.
const web = join(root, "apps/web/src");
const uiProblems: string[] = [];
const within = (file: string, dir: string) => relative(join(web, dir), file).split("/")[0] !== "..";
const target = (file: string, specifier: string) => relative(web, resolve(dirname(file), specifier));
for (const file of walk(web).filter((path) => /\.(ts|tsx)$/.test(path))) {
  const text = readFileSync(file, "utf8");
  const name = relative(web, file);
  const rule = (message: string) => uiProblems.push(`apps/web/src/${name}: ${message}`);
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1]!;
    if (!specifier.startsWith(".")) {
      // Pure modules stay pure: no DOM rendering in models.
      if (within(file, "model") && specifier.startsWith("solid-js")) rule(`imports "${specifier}" (models are pure data)`);
      continue;
    }
    const to = target(file, specifier);
    if (within(file, "plugins")) {
      if (name === "plugins/index.ts") continue;
      // Its own stylesheet is its; anything else under plugins/ is another plugin.
      const ownStyles = to.replace(/\?inline$/, "") === name.replace(/\.tsx?$/, ".css");
      if (to.startsWith("plugins/") && !ownStyles) rule(`imports another plugin "${specifier}" (use a capability, slot, or part)`);
      else if (to.startsWith("components/") && name !== "plugins/kit.tsx") rule(`imports "${specifier}" (draw it through ui/parts.tsx, so it can be replaced)`);
      else if (to.startsWith("ui/") && !["ui/contracts.ts", "ui/define.ts", "ui/slots.ts", "ui/parts.tsx"].includes(to))
        rule(`imports "${specifier}" (plugins use ui/contracts, define, slots, and parts)`);
    } else if (within(file, "components")) {
      if (to.startsWith("plugins/")) rule(`imports a plugin "${specifier}"`);
      else if (to.startsWith("components/")) rule(`imports "${specifier}" (a part draws other parts through ui/parts.tsx)`);
    } else if (within(file, "model") || within(file, "lib")) {
      if (to.startsWith("plugins/") || to.startsWith("components/") || to === "ui/parts.tsx")
        rule(`imports "${specifier}" (models and helpers render nothing)`);
    } else if (to.startsWith("plugins/") && to !== "plugins/index.ts") {
      // The boot and the app's frame know plugins only as the bundled list: what runs is up to the composition.
      rule(`imports the plugin "${specifier}" (only plugins/index.ts, the bundled list)`);
    }
  }
  if (within(file, "model") && name.endsWith(".tsx")) rule("is a .tsx model (models are pure data)");
  if (within(file, "plugins")) {
    // A plugin keeps to what it owns: its DOM (through refs), its slot items, and the page's look only through lib/paint.
    for (const [pattern, why] of [
      [/document\.(querySelector|querySelectorAll|getElementById|getElementsBy\w+)\b/, "queries the whole page (use a ref, or query your own element)"],
      [/document\.body\b/, "reaches into <body> (draw overlays as Layers items)"],
      [/document\.documentElement\b/, "touches <html> (the look goes through lib/paint.ts)"],
    ] as const) {
      if (pattern.test(text)) rule(why);
    }
    // One owner of global keys: overlays handle keys on their own element, and app keys are Actions.
    if (!["plugins/keymap.ts", "plugins/tooltips.tsx"].includes(name) && /(document|window)\.addEventListener\(\s*["']key/.test(text)) {
      rule("listens to keys page-wide (add an Action, or handle keys on your own element)");
    }
  }
}
// What covers the page stacks by the `--z-*` tokens, so a layer from a UI file can slot in between.
for (const file of walk(web).filter((path) => path.endsWith(".css"))) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      const value = /z-index:\s*(\d+)/.exec(line)?.[1];
      if (value !== undefined && Number(value) > 20) uiProblems.push(`${relative(root, file)}:${index + 1}: z-index ${value} (use a --z-* token)`);
    });
}
if (uiProblems.length) {
  console.error(`Web UI boundary violations (see apps/web/AGENTS.md):\n${uiProblems.map((problem) => `  ${problem}`).join("\n")}`);
  process.exit(1);
}
console.log("web ui boundary: ok");
