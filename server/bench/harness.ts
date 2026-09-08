import { Bench, type BenchOptions } from "tinybench";
import { withCodSpeed as codspeedWithCodSpeed } from "@codspeed/tinybench-plugin";

const DEFAULT_BENCH_OPTIONS: BenchOptions = {
  // Short but stable locally; under CodSpeed the runner drives the measurement.
  time: 200,
  warmupTime: 50,
};

/** Creates a tinybench suite with the shared defaults. */
export function createBench(name: string, options: BenchOptions = {}): Bench {
  return new Bench({ name, ...DEFAULT_BENCH_OPTIONS, ...options });
}

/**
 * Wraps a suite so CodSpeed measures it when running under the CodSpeed runner,
 * and leaves it untouched otherwise.
 *
 * The cast works around the plugin resolving its own `tinybench` copy for types
 * (vitest pulls in a different major at the workspace root); at runtime the
 * plugin only patches the instance it is handed.
 *
 * `withCodSpeed` derives the benchmark URI from the file that calls it, so each
 * `*.bench.ts` module must call this itself rather than delegating to a shared
 * entry point.
 */
export const withCodSpeed = codspeedWithCodSpeed as unknown as (bench: Bench) => Bench;

/** Runs a suite and prints its results, mirroring tinybench's default report. */
export async function runSuite(bench: Bench): Promise<void> {
  await bench.run();
  const rows = bench.table().filter((row) => row !== null);
  if (rows.length > 0) {
    console.log(`\n${bench.name ?? "benchmarks"}`);
    console.table(rows);
  }
}
