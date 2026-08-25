import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { getConfig } from "../config/index.js";
import { openDb } from "../db/client.js";
import { createEmbyClient } from "../integrations/emby.js";
import { createJellyfinClient } from "../integrations/jellyfin.js";
import { createPlexClient } from "../integrations/plex.js";
import { createRadarrClient } from "../integrations/radarr.js";
import { createSonarrClient } from "../integrations/sonarr.js";
import { detectHardware } from "../transcode/hardware.js";

export async function runDoctor(): Promise<void> {
  console.log("\n\x1b[1m\x1b[36m======================================================================\x1b[0m");
  console.log("\x1b[1m\x1b[37m  SHRINKARR SYSTEM & HARDWARE DOCTOR\x1b[0m");
  console.log("\x1b[1m\x1b[36m======================================================================\x1b[0m\n");

  let totalChecks = 0;
  let passedChecks = 0;
  let warningChecks = 0;
  let failedChecks = 0;

  const logPass = (title: string, detail?: string) => {
    totalChecks++;
    passedChecks++;
    console.log(`  \x1b[32m[✓]\x1b[0m \x1b[1m${title}\x1b[0m${detail ? ` (${detail})` : ""}`);
  };

  const logWarn = (title: string, detail?: string) => {
    totalChecks++;
    warningChecks++;
    console.log(`  \x1b[33m[!]\x1b[0m \x1b[1m\x1b[33m${title}\x1b[0m${detail ? ` (${detail})` : ""}`);
  };

  const logFail = (title: string, detail?: string) => {
    totalChecks++;
    failedChecks++;
    console.log(`  \x1b[31m[✗]\x1b[0m \x1b[1m\x1b[31m${title}\x1b[0m${detail ? ` (${detail})` : ""}`);
  };

  // 1. Environment & Config
  console.log("\x1b[1m\x1b[34m[ 1. CONFIGURATION & ENVIRONMENT ]\x1b[0m");
  const isContainer = fs.existsSync("/.dockerenv") || (fs.existsSync("/proc/1/cgroup") && fs.readFileSync("/proc/1/cgroup", "utf8").includes("docker"));
  if (isContainer) {
    logPass("Docker Environment", `Container detected, UID=${process.getuid?.() ?? "N/A"}, GID=${process.getgid?.() ?? "N/A"}`);
  } else {
    logPass("Host Environment", `${os.type()} ${os.release()} (${os.arch()})`);
  }

  let config;
  const configPath = process.env.SHRINKARR_CONFIG ?? "config/config.yaml";
  try {
    config = getConfig();
    logPass("Configuration File", `${configPath} (Valid & Loaded)`);
  } catch (err) {
    logFail("Configuration File", (err as Error).message);
  }

  // 2. Database
  console.log("\n\x1b[1m\x1b[34m[ 2. DATABASE & STORAGE ]\x1b[0m");
  if (config) {
    try {
      const db = openDb(config.dbPath);
      logPass("SQLite Database", `${config.dbPath} (Accessible & Migrations Applied)`);
      db.close();
    } catch (err) {
      logFail("SQLite Database", (err as Error).message);
    }
  }

  // 3. Media Libraries
  if (config && config.libraries) {
    for (const lib of config.libraries) {
      if (fs.existsSync(lib.path)) {
        try {
          fs.accessSync(lib.path, fs.constants.R_OK);
          logPass(`Library "${lib.name}"`, `${lib.path} accessible`);
        } catch {
          logWarn(`Library "${lib.name}"`, `${lib.path} exists but permission denied`);
        }
      } else {
        logWarn(`Library "${lib.name}"`, `Directory not found: ${lib.path}`);
      }
    }
  }

  // 4. FFmpeg Toolchain
  console.log("\n\x1b[1m\x1b[34m[ 3. MEDIA TOOLCHAIN (FFMPEG & FFPROBE) ]\x1b[0m");
  try {
    const ffmpegVer = execSync("ffmpeg -version", { encoding: "utf8", timeout: 3000 });
    const firstLine = ffmpegVer.split("\n")[0] || "ffmpeg installed";
    logPass("FFmpeg Executable", firstLine);
  } catch {
    logFail("FFmpeg Executable", "ffmpeg is not installed or not found in system PATH");
  }

  try {
    const ffprobeVer = execSync("ffprobe -version", { encoding: "utf8", timeout: 3000 });
    const firstLine = ffprobeVer.split("\n")[0] || "ffprobe installed";
    logPass("FFprobe Executable", firstLine);
  } catch {
    logFail("FFprobe Executable", "ffprobe is not installed or not found in system PATH");
  }

  // 5. Hardware Acceleration & Render Nodes
  console.log("\n\x1b[1m\x1b[34m[ 4. GPU & HARDWARE ACCELERATION ]\x1b[0m");
  if (os.platform() === "linux") {
    if (fs.existsSync("/dev/dri")) {
      logPass("DRM Directory", "/dev/dri present");
    } else {
      logWarn("DRM Directory", "/dev/dri not found (missing GPU device passthrough in Docker?)");
    }
  }

  const hwReport = await detectHardware(true);

  if (hwReport.renderNodes.length > 0) {
    const nodesSummary = hwReport.renderNodes
      .map((n) => `${n.path} (${n.deviceName || n.driver || "GPU"})`)
      .join(", ");
    logPass("Render Nodes", nodesSummary);
  }

  const hwEncoders = hwReport.encoders.filter((e) => e.hwaccelType !== "cpu");
  if (hwEncoders.length > 0) {
    const names = hwEncoders
      .map((e) => {
        const dev = e.devicePath ? ` [${e.devicePath.replace("/dev/dri/", "")}]` : "";
        return `${e.id}${dev}`;
      })
      .join(", ");
    logPass("GPU Hardware Encoders", `${hwEncoders.length} active: ${names}`);

    const recHevc = hwReport.recommendations?.hevc;
    const recAv1 = hwReport.recommendations?.av1;
    const recH264 = hwReport.recommendations?.h264;

    const formatEnc = (rec?: { encoderId: string; deviceName?: string; devicePath?: string }) => {
      if (!rec) return "N/A";
      const dev = rec.deviceName ? ` on ${rec.deviceName}` : "";
      const path = rec.devicePath ? ` (${rec.devicePath})` : "";
      return `${rec.encoderId}${dev}${path}`;
    };

    logPass("Optimal Hardware Routing", `HEVC: ${formatEnc(recHevc)} | AV1: ${formatEnc(recAv1)} | H.264: ${formatEnc(recH264)}`);
  } else {
    logWarn("GPU Hardware Encoders", "No GPU encoders active; falling back to software CPU encoding");
  }

  // 5. Media Server & *Arr Integrations
  const integrations = config?.integrations;
  if (integrations && Object.keys(integrations).length > 0) {
    console.log("\n\x1b[1m\x1b[34m[ 5. MEDIA SERVER & *ARR INTEGRATIONS ]\x1b[0m");

    if (integrations.jellyfin?.url) {
      const client = createJellyfinClient(integrations.jellyfin);
      const res = await client.testConnection?.();
      if (res?.ok) {
        logPass("Jellyfin Integration", `${integrations.jellyfin.url} - ${res.message}`);
      } else {
        logWarn("Jellyfin Integration", `${integrations.jellyfin.url} - ${res?.message || "Failed"}`);
      }
    }

    if (integrations.sonarr?.url) {
      const client = createSonarrClient(integrations.sonarr);
      const res = await client.testConnection?.();
      if (res?.ok) {
        logPass("Sonarr Integration", `${integrations.sonarr.url} - ${res.message}`);
      } else {
        logWarn("Sonarr Integration", `${integrations.sonarr.url} - ${res?.message || "Failed"}`);
      }
    }

    if (integrations.radarr?.url) {
      const client = createRadarrClient(integrations.radarr);
      const res = await client.testConnection?.();
      if (res?.ok) {
        logPass("Radarr Integration", `${integrations.radarr.url} - ${res.message}`);
      } else {
        logWarn("Radarr Integration", `${integrations.radarr.url} - ${res?.message || "Failed"}`);
      }
    }

    if (integrations.plex?.url) {
      const client = createPlexClient(integrations.plex);
      const res = await client.testConnection?.();
      if (res?.ok) {
        logPass("Plex Integration", `${integrations.plex.url} - ${res.message}`);
      } else {
        logWarn("Plex Integration", `${integrations.plex.url} - ${res?.message || "Failed"}`);
      }
    }

    if (integrations.emby?.url) {
      const client = createEmbyClient(integrations.emby);
      const res = await client.testConnection?.();
      if (res?.ok) {
        logPass("Emby Integration", `${integrations.emby.url} - ${res.message}`);
      } else {
        logWarn("Emby Integration", `${integrations.emby.url} - ${res?.message || "Failed"}`);
      }
    }
  }

  // 6. Final Verdict
  console.log("\n\x1b[1m\x1b[36m======================================================================\x1b[0m");
  if (failedChecks === 0 && warningChecks === 0) {
    console.log(`\x1b[1m\x1b[32m  STATUS: EXCELLENT (${passedChecks}/${totalChecks} checks passed)\x1b[0m`);
    console.log("  All system components and hardware acceleration engines are fully operational.");
  } else if (failedChecks === 0) {
    console.log(`\x1b[1m\x1b[33m  STATUS: HEALTHY WITH WARNINGS (${passedChecks}/${totalChecks} passed, ${warningChecks} warnings)\x1b[0m`);
  } else {
    console.log(`\x1b[1m\x1b[31m  STATUS: ISSUES DETECTED (${failedChecks} failures, ${warningChecks} warnings)\x1b[0m`);
  }
  console.log("\x1b[1m\x1b[36m======================================================================\x1b[0m\n");
}
