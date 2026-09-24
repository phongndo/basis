import { cpus } from "node:os";
import { Effect, Layer } from "effect";
import { definePlugin, Hook, Hooks, makeCore, PluginContext } from "../src/index.ts";

// Warm microbenchmarks, not end-to-end latency or a comparison with another harness.
// Every reported value is a batch mean. Samples use fresh Effect runtime entry but
// dispatch cases reuse a mounted core, with one core.run per batch (not per hook).
const samples = 7;
const iterations = 10_000;
const point = Hook.make<number, number>("bench/increment");
const terminal = (value: number) => Effect.succeed(value + 1);
const plugins = (count: number) => Array.from({ length: count }, (_, index) => definePlugin({
  id: `plugin-${String(index).padStart(3, "0")}`,
  layer: Layer.effectDiscard(Effect.gen(function* () {
    const owner = yield* PluginContext;
    yield* owner.on(point, (value, next) => next(value));
  })),
}));

function repeat<A, E, R>(operation: Effect.Effect<A, E, R>, count: number): Effect.Effect<void, E, R> {
  return Effect.gen(function* () {
    for (let i = 0; i < count; i++) yield* operation;
  });
}

async function measure<E>(name: string, count: number, effect: Effect.Effect<void, E>) {
  await Effect.runPromise(effect);
  const values: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    await Effect.runPromise(effect);
    values.push((performance.now() - start) * 1_000 / count);
  }
  values.sort((a, b) => a - b);
  console.log(`${name.padEnd(33)} ${values[Math.floor(samples / 2)]!.toFixed(3).padStart(9)} µs/op  [${values[0]!.toFixed(3)}, ${values.at(-1)!.toFixed(3)}]`);
}

console.log(`Bun ${Bun.version} · ${process.platform}/${process.arch} · ${cpus()[0]?.model}`);
console.log(`Median batch means, ${samples} samples; brackets show min/max. No external trace exporter.\n`);
await measure("Effect direct", iterations, repeat(terminal(1), iterations));

for (const count of [0, 1, 8, 32]) {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const core = yield* makeCore(plugins(count));
    const hooks = yield* core.run(Hooks);
    const batch = core.run(repeat(hooks.invoke(point, 1, terminal), iterations));
    yield* Effect.promise(() => measure(`Hook / ${count} handlers / spans on`, iterations, batch));
    yield* Effect.promise(() => measure(`Hook / ${count} handlers / spans off`, iterations, batch.pipe(Effect.withTracerEnabled(false))));
  })));
}

await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const core = yield* makeCore([]);
  yield* Effect.promise(() => measure("core.run entry", iterations, repeat(core.run(Effect.void), iterations)));
})));

for (const count of [0, 8, 32]) {
  const composition = plugins(count);
  await measure(`Mount + dispose / ${count} plugins`, 100, repeat(Effect.scoped(makeCore(composition)), 100));
}
