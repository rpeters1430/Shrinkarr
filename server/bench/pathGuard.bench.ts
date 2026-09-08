import { isPathInsideLibraries } from "../src/scanner/pathGuard.js";
import { createBench, withCodSpeed } from "./harness.js";
import { makeCandidatePaths, makeLibraries } from "./fixtures.js";

const bench = withCodSpeed(createBench("scanner/pathGuard"));

const fewLibraries = makeLibraries(2);
const manyLibraries = makeLibraries(24);
const paths = makeCandidatePaths(500, 24);
const singlePath = paths[0];

bench.add("isPathInsideLibraries, single path, 24 libraries", () => {
  isPathInsideLibraries(singlePath, manyLibraries);
});

bench.add("500 paths against 2 libraries", () => {
  let inside = 0;
  for (const path of paths) {
    if (isPathInsideLibraries(path, fewLibraries)) {
      inside += 1;
    }
  }
  return inside;
});

bench.add("500 paths against 24 libraries", () => {
  let inside = 0;
  for (const path of paths) {
    if (isPathInsideLibraries(path, manyLibraries)) {
      inside += 1;
    }
  }
  return inside;
});

export default bench;
