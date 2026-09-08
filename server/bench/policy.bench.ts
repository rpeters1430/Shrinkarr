import { decide, estimateSavingsPercent } from "../src/scanner/policy.js";
import { createBench, withCodSpeed } from "./harness.js";
import { BASE_PRESET, PRESET_MATRIX, makeProbes } from "./fixtures.js";

const bench = withCodSpeed(createBench("scanner/policy"));

const probes = makeProbes(2_000);
const smallProbes = makeProbes(200, 99);

bench.add("estimateSavingsPercent over 2000 probes", () => {
  let total = 0;
  for (const probe of probes) {
    total += estimateSavingsPercent(probe, BASE_PRESET);
  }
  return total;
});

bench.add("decide over 2000 probes (single preset)", () => {
  let eligible = 0;
  for (const probe of probes) {
    if (decide(probe, BASE_PRESET).shouldTranscode) {
      eligible += 1;
    }
  }
  return eligible;
});

bench.add("decide over 2000 probes with library overrides", () => {
  let eligible = 0;
  for (let i = 0; i < probes.length; i += 1) {
    const decision = decide(probes[i], BASE_PRESET, {
      mediaType: i % 3 === 0 ? "youtube" : "movie",
      minFileSizeMb: i % 5 === 0 ? 25 : undefined,
    });
    if (decision.shouldTranscode) {
      eligible += 1;
    }
  }
  return eligible;
});

bench.add("decide across the full preset matrix (200 probes x 11 presets)", () => {
  let eligible = 0;
  for (const probe of smallProbes) {
    for (const preset of PRESET_MATRIX) {
      if (decide(probe, preset).shouldTranscode) {
        eligible += 1;
      }
    }
  }
  return eligible;
});

export default bench;
