#!/usr/bin/env node
import { Command } from "commander";
import { runScan } from "./scanCommand.js";
import { runDaemon } from "./runCommand.js";
import { startServer } from "../api/server.js";
import { runStart } from "./startCommand.js";

const program = new Command();

program
  .name("shrinkarr")
  .description("Self-hosted media transcoding tool")
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

program.parseAsync(process.argv);
