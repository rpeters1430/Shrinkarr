import { detectHardware, testEncoderWorking } from "../transcode/hardware.js";

export interface HardwareCliOptions {
  benchmark?: boolean;
  json?: boolean;
  refresh?: boolean;
}

export async function runHardware(options: HardwareCliOptions = {}): Promise<void> {
  const report = await detectHardware(options.refresh || true);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("\n\x1b[1m\x1b[36m======================================================================\x1b[0m");
  console.log("\x1b[1m\x1b[37m  SHRINKARR HARDWARE ACCELERATION & RENDER INFO REPORT\x1b[0m");
  console.log("\x1b[1m\x1b[36m======================================================================\x1b[0m");
  console.log(`\x1b[2mPlatform:\x1b[0m ${report.platform} (${report.os})  |  \x1b[2mTested At:\x1b[0m ${report.testedAt}\n`);

  // 1. Detected GPUs
  console.log("\x1b[1m\x1b[34m[ 1. DETECTED GRAPHICS HARDWARE ]\x1b[0m");
  if (report.gpus.length === 0) {
    console.log("  \x1b[33m[!] No dedicated GPU or display adapter found.\x1b[0m");
  } else {
    for (const gpu of report.gpus) {
      const vendorBadge = gpu.vendor === "intel"
        ? "\x1b[34m[Intel]\x1b[0m"
        : gpu.vendor === "amd"
          ? "\x1b[31m[AMD]\x1b[0m"
          : gpu.vendor === "nvidia"
            ? "\x1b[32m[NVIDIA]\x1b[0m"
            : "\x1b[35m[Apple]\x1b[0m";
      console.log(`  \x1b[32m[✓]\x1b[0m ${vendorBadge} \x1b[1m${gpu.name}\x1b[0m${gpu.driverVersion ? ` (Driver: ${gpu.driverVersion})` : ""}`);
    }
  }

  // 2. DRM Render Nodes & VA-API Capabilities
  if (report.renderNodes && report.renderNodes.length > 0) {
    console.log("\n\x1b[1m\x1b[34m[ 2. DRM RENDER NODES & VA-API INFO ]\x1b[0m");
    for (const node of report.renderNodes) {
      console.log(`\n  \x1b[1m\x1b[36m• Render Node: ${node.path}\x1b[0m`);
      console.log(`    \x1b[2mDriver:\x1b[0m         ${node.driver || "Unknown"}`);
      console.log(`    \x1b[2mVA-API Version:\x1b[0m ${node.vaapiVersion || "Unknown"}`);
      console.log(`    \x1b[2mPermissions:\x1b[0m    ${node.readable && node.writable ? "\x1b[32mRead/Write OK\x1b[0m" : "\x1b[31mPermission Denied\x1b[0m"}`);

      if (node.codecs) {
        console.log("\n    \x1b[1mSupported Codec Acceleration:\x1b[0m");
        const formatRow = (name: string, dec: boolean, enc: boolean) => {
          const decStr = dec ? "\x1b[32mSupported [✓]\x1b[0m" : "\x1b[2m-\x1b[0m           ";
          const encStr = enc ? "\x1b[32mSupported [✓]\x1b[0m" : "\x1b[2m-\x1b[0m           ";
          console.log(`      ${name.padEnd(26)}  Decode: ${decStr}   Encode: ${encStr}`);
        };

        formatRow("H.264 / AVC (8-bit)", node.codecs.h264.decode, node.codecs.h264.encode);
        formatRow("HEVC / H.265 (8-bit)", node.codecs.hevc.decode, node.codecs.hevc.encode);
        formatRow("HEVC Main 10 (10-bit / HDR)", node.codecs.hevc10.decode, node.codecs.hevc10.encode);
        formatRow("AV1 (Profile 0)", node.codecs.av1.decode, node.codecs.av1.encode);
        formatRow("Google VP9", node.codecs.vp9.decode, node.codecs.vp9.encode);
      }
    }
  }

  // 3. Verified Encoders & Speed Benchmark
  console.log("\n\x1b[1m\x1b[34m[ 3. VERIFIED TRANSCODE ENCODERS ]\x1b[0m");
  if (report.encoders.length === 0) {
    console.log("  \x1b[31m[✗] No working encoders verified!\x1b[0m");
  } else {
    for (const enc of report.encoders) {
      const typeBadge = enc.hwaccelType === "cpu"
        ? "\x1b[33m[CPU SOFTWARE]\x1b[0m"
        : `\x1b[32m[⚡ ${enc.hwaccelType.toUpperCase()}]\x1b[0m`;
      const speedStr = enc.speedMultiplier ? `(Speed: \x1b[1m\x1b[32m${enc.speedMultiplier.toFixed(1)}x\x1b[0m real-time)` : "";
      const devStr = enc.devicePath ? ` [\x1b[36m${enc.devicePath}\x1b[0m${enc.deviceName ? ` - ${enc.deviceName}` : ""}]` : "";
      console.log(`  \x1b[32m[✓]\x1b[0m ${typeBadge} \x1b[1m${enc.name}\x1b[0m (\x1b[36m${enc.id}\x1b[0m)${devStr} ${speedStr}`);
      console.log(`      \x1b[2m${enc.description}\x1b[0m`);
    }
  }

  // 4. Recommendations
  console.log("\n\x1b[1m\x1b[34m[ 4. OPTIMAL ENCODER SELECTIONS ]\x1b[0m");
  const formatRec = (rec?: { encoderId: string; deviceName?: string; devicePath?: string; speedMultiplier?: number }, fallbackId = "") => {
    if (!rec) return `\x1b[32m${fallbackId}\x1b[0m`;
    const dev = rec.deviceName ? ` -> \x1b[1m${rec.deviceName}\x1b[0m` : "";
    const node = rec.devicePath ? ` (\x1b[36m${rec.devicePath}\x1b[0m)` : "";
    const spd = rec.speedMultiplier ? ` [\x1b[32m${rec.speedMultiplier.toFixed(1)}x\x1b[0m]` : "";
    return `\x1b[32m${rec.encoderId}\x1b[0m${dev}${node}${spd}`;
  };

  console.log(`  • \x1b[1mHEVC (H.265):\x1b[0m  ${formatRec(report.recommendations?.hevc, report.recommendedHevc)}`);
  console.log(`  • \x1b[1mAV1:\x1b[0m           ${formatRec(report.recommendations?.av1, report.recommendedAv1)}`);
  console.log(`  • \x1b[1mH.264:\x1b[0m         ${formatRec(report.recommendations?.h264, report.recommendedH264)}`);
  console.log(`\n  \x1b[1mSummary:\x1b[0m ${report.summary}`);

  // Optional: Extended multi-resolution benchmark
  if (options.benchmark) {
    console.log("\n\x1b[1m\x1b[34m[ 5. EXTENDED MULTI-RESOLUTION BENCHMARK ]\x1b[0m");
    console.log("  Running 1080p and 4K HDR transcode tests...\n");

    for (const enc of report.encoders) {
      const devArgs = enc.devicePath ? ["-vaapi_device", enc.devicePath, "-vf", "format=nv12|vaapi,hwupload"] : [];
      const devArgs10 = enc.devicePath ? ["-vaapi_device", enc.devicePath, "-vf", "format=p010|vaapi,hwupload"] : [];

      process.stdout.write(`  Benchmarking ${enc.name.padEnd(28)} (1080p)... `);
      const res1080 = await testEncoderWorking(enc.id, devArgs, { width: 1920, height: 1080, duration: 1.5 });
      if (res1080.ok) {
        console.log(`\x1b[32m[PASS]\x1b[0m Speed: \x1b[1m\x1b[32m${(res1080.speedMultiplier || 1).toFixed(1)}x\x1b[0m (FPS: ${res1080.fps || "N/A"})`);
      } else {
        console.log("\x1b[31m[FAIL]\x1b[0m");
      }

      if (enc.codec === "hevc" || enc.codec === "av1") {
        process.stdout.write(`  Benchmarking ${enc.name.padEnd(28)} (4K HDR)... `);
        const res4k = await testEncoderWorking(enc.id, devArgs10, { width: 3840, height: 2160, duration: 2.0, bitDepth: 10 });
        if (res4k.ok) {
          console.log(`\x1b[32m[PASS]\x1b[0m Speed: \x1b[1m\x1b[32m${(res4k.speedMultiplier || 1).toFixed(1)}x\x1b[0m (FPS: ${res4k.fps || "N/A"})`);
        } else {
          console.log("\x1b[33m[SKIPPED / UNSUPPORTED]\x1b[0m");
        }
      }
    }
  }

  console.log("\n\x1b[1m\x1b[36m======================================================================\x1b[0m\n");
}
