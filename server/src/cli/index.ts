#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { runScan } from "./scanCommand.js";
import { runDaemon } from "./runCommand.js";
import { startServer } from "../api/server.js";
import { runStart } from "./startCommand.js";
import { runHardware } from "./hardwareCommand.js";
import { runDoctor } from "./doctorCommand.js";

// Windows FFmpeg PATH auto-discovery fallback
if (os.platform() === "win32") {
  const checkPaths = [
    path.resolve(process.cwd(), "bin"),
    path.resolve(process.cwd(), "bin/ffmpeg/bin"),
    path.resolve(process.cwd(), "tools/ffmpeg/bin"),
    "C:\\ffmpeg\\bin",
    "C:\\Program Files\\ffmpeg\\bin",
    "C:\\Program Files (x86)\\ffmpeg\\bin",
    path.join(process.env.LOCALAPPDATA || "", "Microsoft\\WindowsApps"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft\\WinGet\\Links"),
  ];

  for (const p of checkPaths) {
    if (fs.existsSync(path.join(p, "ffmpeg.exe")) && !process.env.PATH?.includes(p)) {
      process.env.PATH = `${p};${process.env.PATH}`;
      break;
    }
  }

  const wingetPkg = path.join(process.env.LOCALAPPDATA || "", "Microsoft\\WinGet\\Packages");
  if (fs.existsSync(wingetPkg)) {
    try {
      const dirs = fs.readdirSync(wingetPkg);
      for (const d of dirs) {
        if (d.toLowerCase().includes("ffmpeg")) {
          const sub = path.join(wingetPkg, d);
          const entries = fs.readdirSync(sub, { recursive: true });
          for (const entry of entries) {
            const str = String(entry);
            if (str.endsWith("ffmpeg.exe")) {
              const binDir = path.dirname(path.join(sub, str));
              if (!process.env.PATH?.includes(binDir)) {
                process.env.PATH = `${binDir};${process.env.PATH}`;
              }
              break;
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }
}

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
