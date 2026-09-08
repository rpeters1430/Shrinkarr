import { runSuite } from "./harness.js";
import configBench from "./config.bench.js";
import dbBench from "./db.bench.js";
import ffmpegArgsBench from "./ffmpegArgs.bench.js";
import ffprobeBench from "./ffprobe.bench.js";
import pathGuardBench from "./pathGuard.bench.js";
import policyBench from "./policy.bench.js";
import statsRouteBench from "./statsRoute.bench.js";

const suites = [
  configBench,
  ffprobeBench,
  policyBench,
  pathGuardBench,
  ffmpegArgsBench,
  dbBench,
  statsRouteBench,
];

for (const suite of suites) {
  await runSuite(suite);
}
