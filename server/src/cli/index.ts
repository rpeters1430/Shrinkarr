#!/usr/bin/env node
import { Command } from "commander";
import { runScan } from "./scanCommand.js";
import { runDaemon } from "./runCommand.js";
import { startServer } from "../api/server.js";
import { runStart } from "./startCommand.js";
import { runHardware } from "./hardwareCommand.js";
import { runDoctor } from "./doctorCommand.js";

const program = new Command();

program
  .name("shrinkarr")
  .description("Self-hosted media transcoding and storage optimization tool")
  .option("--config <path>", "path to config.yaml")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts<{ config?: string }>();
    if (opts.config) {
      process.env.SHRINKARR_CONFIG = opts.config;
    }
  });

program
  .command("scan")
  .description("Scan all configured libraries and report/enqueue transcode candidates")
  .action(async () => {
    await runScan();
  });

program
  .command("run")
  .description("Start the transcode queue processor as a foreground daemon")
  .action(async () => {
    await runDaemon();
  });

program
  .command("serve")
  .description("Start the REST API server")
  .option("-p, --port <port>", "port to listen on", "3000")
  .action(async (opts: { port: string }) => {
    await startServer(parseInt(opts.port, 10));
  });

program
  .command("start")
  .description("Start the API server and the queue processor together (single-container mode)")
  .option("-p, --port <port>", "port to listen on", "3000")
  .action(async (opts: { port: string }) => {
    await runStart(parseInt(opts.port, 10));
  });

program
  .command("hardware")
  .description("Inspect GPU hardware acceleration, DRM render nodes, and test encoders")
  .option("-b, --benchmark", "run extended 1080p and 4K HDR transcode speed benchmarks")
  .option("-j, --json", "output hardware report in JSON format")
  .action(async (opts: { benchmark?: boolean; json?: boolean }) => {
    await runHardware(opts);
  });

program
  .command("doctor")
  .description("Run a full health check across system, database, storage, and GPU transcoding engines")
  .action(async () => {
    await runDoctor();
  });

program.parseAsync(process.argv);
