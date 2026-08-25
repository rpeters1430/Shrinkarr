import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

export interface DetectedGpu {
  name: string;
  vendor: "nvidia" | "intel" | "amd" | "apple" | "other";
  driverVersion?: string;
  renderNode?: string;
}

export interface DetectedEncoder {
  id: string;
  name: string;
  codec: "hevc" | "av1" | "h264";
  hwaccelType: "amf" | "qsv" | "nvenc" | "vaapi" | "videotoolbox" | "cpu";
  working: boolean;
  speedMultiplier?: number;
  fps?: number;
  description: string;
  devicePath?: string;
  deviceName?: string;
}

export interface DetectedRenderNode {
  path: string;
  driver?: string;
  deviceName?: string;
  vendor?: "nvidia" | "intel" | "amd" | "apple" | "other";
  vaapiVersion?: string;
  readable: boolean;
  writable: boolean;
  codecs: {
    h264: { decode: boolean; encode: boolean };
    hevc: { decode: boolean; encode: boolean };
    hevc10: { decode: boolean; encode: boolean };
    av1: { decode: boolean; encode: boolean };
    vp9: { decode: boolean; encode: boolean };
  };
}

export interface RecommendedEncoderSelection {
  encoderId: string;
  hwaccelType: "amf" | "qsv" | "nvenc" | "vaapi" | "videotoolbox" | "cpu";
  devicePath?: string;
  deviceName?: string;
  speedMultiplier?: number;
}

export interface HardwareReport {
  os: string;
  platform: NodeJS.Platform;
  gpus: DetectedGpu[];
  renderNodes: DetectedRenderNode[];
  primaryRenderNode?: string;
  encoders: DetectedEncoder[];
  recommendedHevc: string;
  recommendedAv1: string;
  recommendedH264: string;
  recommendations?: {
    hevc: RecommendedEncoderSelection;
    av1: RecommendedEncoderSelection;
    h264: RecommendedEncoderSelection;
  };
  summary: string;
  testedAt: string;
}

let cachedReport: HardwareReport | undefined;

function runCommandSafe(cmd: string, timeout = 4000): string {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8", timeout });
  } catch {
    return "";
  }
}

function formatGpuName(rawName: string, vendor: string, driver?: string): string {
  if (vendor === "amd") {
    if (driver) {
      const m = driver.match(/for\s+(AMD\s+[^()]+)/i);
      if (m && m[1]) return m[1].trim();
    }
    const mBracket = rawName.match(/\[([^\]]+)\]/);
    if (mBracket && mBracket[1]) {
      const b = mBracket[1];
      if (b.includes("Radeon RX 9070")) return "AMD Radeon RX 9070 XT";
      return b.startsWith("AMD") || b.startsWith("Radeon") ? b : `AMD ${b}`;
    }
    return rawName.startsWith("AMD") ? rawName : `AMD ${rawName}`;
  }
  if (vendor === "intel") {
    const mBracket = rawName.match(/\[([^\]]+)\]/);
    if (mBracket && mBracket[1]) {
      return `Intel ${mBracket[1]}`;
    }
    if (rawName.includes("Intel")) return rawName;
    return `Intel ${rawName}`;
  }
  return rawName;
}

export function scanRenderNodes(): DetectedRenderNode[] {
  const nodes: DetectedRenderNode[] = [];
  if (os.platform() !== "linux" || !fs.existsSync("/dev/dri")) {
    return nodes;
  }

  try {
    const files = fs.readdirSync("/dev/dri");
    const renderFiles = files.filter((f) => f.startsWith("renderD")).sort();
    const lspciOutput = runCommandSafe("lspci");

    for (const file of renderFiles) {
      const devPath = `/dev/dri/${file}`;
      let readable = false;
      let writable = false;

      try {
        fs.accessSync(devPath, fs.constants.R_OK);
        readable = true;
      } catch {
        readable = false;
      }

      try {
        fs.accessSync(devPath, fs.constants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }

      let driver: string | undefined;
      let rawDeviceName: string | undefined;
      let vendor: DetectedRenderNode["vendor"] = "other";
      let vaapiVersion: string | undefined;
      const codecs = {
        h264: { decode: false, encode: false },
        hevc: { decode: false, encode: false },
        hevc10: { decode: false, encode: false },
        av1: { decode: false, encode: false },
        vp9: { decode: false, encode: false },
      };

      // Try resolving PCI device name from sysfs
      try {
        const sysPath = `/sys/class/drm/${file}`;
        if (fs.existsSync(sysPath)) {
          const realPath = fs.realpathSync(sysPath);
          const pciMatch = realPath.match(/([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])\/drm/i);
          if (pciMatch && lspciOutput) {
            const pciId = pciMatch[1].replace(/^0000:/, "");
            const lspciLine = lspciOutput.split("\n").find((l) => l.startsWith(pciId));
            if (lspciLine) {
              const clean = lspciLine
                .replace(/^[0-9a-f:.]+\s+(VGA compatible controller|Display controller|3D controller):\s+/i, "")
                .replace(/^Advanced Micro Devices, Inc\.\s*\[AMD\/ATI\]\s*/i, "")
                .replace(/^Intel Corporation\s*/i, "")
                .replace(/\s*\(rev [0-9a-f]+\)/i, "")
                .trim();
              if (clean) {
                rawDeviceName = clean;
              }
            }
          }
        }
      } catch {
        // sysfs inspection fallback
      }

      if (readable && writable) {
        const vaOut = runCommandSafe(`vainfo --display drm --device ${devPath} 2>&1`);
        if (vaOut) {
          const driverMatch = vaOut.match(/Driver version:\s*(.+)/i);
          const vaMatch = vaOut.match(/VA-API version:\s*([\d.]+)/i);

          if (driverMatch && driverMatch[1]) {
            driver = driverMatch[1].trim();

            const lower = driver.toLowerCase();
            if (lower.includes("amd") || lower.includes("radeon") || lower.includes("radeonsi")) {
              vendor = "amd";
              if (!rawDeviceName) {
                const amdMatch = driver.match(/for\s+(AMD\s+[^()]+)/i);
                rawDeviceName = amdMatch ? amdMatch[1].trim() : "AMD Radeon GPU";
              }
            } else if (lower.includes("intel") || lower.includes("ihd") || lower.includes("i965")) {
              vendor = "intel";
              if (!rawDeviceName) {
                rawDeviceName = "Intel Graphics (iHD)";
              }
            } else if (lower.includes("nvidia") || lower.includes("nouveau")) {
              vendor = "nvidia";
              if (!rawDeviceName) {
                rawDeviceName = "NVIDIA GPU";
              }
            }
          }
          if (vaMatch && vaMatch[1]) {
            vaapiVersion = vaMatch[1].trim();
          }

          const hasProf = (prof: string, entry: string) => {
            const re = new RegExp(`${prof}[^\\n]*:[^\\n]*${entry}`, "i");
            return re.test(vaOut);
          };

          codecs.h264.decode = hasProf("VAProfileH264", "VAEntrypointVLD");
          codecs.h264.encode = hasProf("VAProfileH264", "VAEntrypointEnc");
          codecs.hevc.decode = hasProf("VAProfileHEVCMain", "VAEntrypointVLD");
          codecs.hevc.encode = hasProf("VAProfileHEVCMain[\\s:]", "VAEntrypointEnc") || hasProf("VAProfileHEVCMain$", "VAEntrypointEnc");
          codecs.hevc10.decode = hasProf("VAProfileHEVCMain10", "VAEntrypointVLD");
          codecs.hevc10.encode = hasProf("VAProfileHEVCMain10", "VAEntrypointEnc");
          codecs.av1.decode = hasProf("VAProfileAV1", "VAEntrypointVLD");
          codecs.av1.encode = hasProf("VAProfileAV1", "VAEntrypointEnc");
          codecs.vp9.decode = hasProf("VAProfileVP9", "VAEntrypointVLD");
          codecs.vp9.encode = hasProf("VAProfileVP9", "VAEntrypointEnc");
        }
      }

      const formattedName = rawDeviceName ? formatGpuName(rawDeviceName, vendor, driver) : (driver ? `${driver} (${file})` : file);

      nodes.push({
        path: devPath,
        driver,
        deviceName: formattedName,
        vendor,
        vaapiVersion,
        readable,
        writable,
        codecs,
      });
    }
  } catch {
    // Ignore scan errors
  }

  return nodes;
}

export function detectGpus(): DetectedGpu[] {
  const gpus: DetectedGpu[] = [];
  const platform = os.platform();

  if (platform === "win32") {
    const output = runCommandSafe(
      'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -Property Name, DriverVersion | ConvertTo-Json"',
    );
    if (output.trim()) {
      try {
        const parsed = JSON.parse(output);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of list) {
          if (item && item.Name) {
            const name = String(item.Name);
            let vendor: DetectedGpu["vendor"] = "other";
            const lower = name.toLowerCase();
            if (lower.includes("nvidia") || lower.includes("geforce") || lower.includes("rtx") || lower.includes("gtx")) vendor = "nvidia";
            else if (lower.includes("intel") || lower.includes("arc") || lower.includes("uhd") || lower.includes("iris")) vendor = "intel";
            else if (lower.includes("amd") || lower.includes("radeon")) vendor = "amd";

            gpus.push({
              name,
              vendor,
              driverVersion: item.DriverVersion ? String(item.DriverVersion) : undefined,
            });
          }
        }
      } catch {
        // fallback
      }
    }
  } else if (platform === "linux") {
    const renderNodes = scanRenderNodes();

    // 1. Try lspci
    const lspci = runCommandSafe("lspci");
    if (lspci) {
      for (const line of lspci.split("\n")) {
        if (line.includes("VGA") || line.includes("3D") || line.includes("Display")) {
          let vendor: DetectedGpu["vendor"] = "other";
          const lower = line.toLowerCase();
          if (lower.includes("nvidia")) vendor = "nvidia";
          else if (lower.includes("intel")) vendor = "intel";
          else if (lower.includes("amd") || lower.includes("radeon") || lower.includes("advanced micro devices")) vendor = "amd";

          const clean = line
            .replace(/^[0-9a-f:.]+\s+(VGA compatible controller|Display controller|3D controller):\s+/i, "")
            .replace(/^Advanced Micro Devices, Inc\.\s*\[AMD\/ATI\]\s*/i, "")
            .replace(/^Intel Corporation\s*/i, "")
            .replace(/\s*\(rev [0-9a-f]+\)/i, "")
            .trim();

          const formatted = formatGpuName(clean, vendor);
          const matchedNode = renderNodes.find((n) => n.vendor === vendor)?.path;

          gpus.push({
            name: formatted || line.trim(),
            vendor,
            renderNode: matchedNode,
          });
        }
      }
    }

    // 2. If lspci didn't find anything (e.g. minimal docker container), check render nodes
    if (gpus.length === 0 && renderNodes.length > 0) {
      for (const node of renderNodes) {
        gpus.push({
          name: node.deviceName || node.driver || node.path,
          vendor: node.vendor || "other",
          renderNode: node.path,
        });
      }
    }

    // 3. Check NVIDIA via nvidia-smi if not already detected
    if (!gpus.some((g) => g.vendor === "nvidia")) {
      const nvSmi = runCommandSafe("nvidia-smi --query-gpu=name,driver_version --format=csv,noheader");
      if (nvSmi.trim()) {
        const [name, driverVersion] = nvSmi.split(",").map((s) => s.trim());
        if (name) {
          gpus.push({
            name,
            vendor: "nvidia",
            driverVersion,
          });
        }
      }
    }
  } else if (platform === "darwin") {
    gpus.push({ name: "Apple Silicon / VideoToolbox", vendor: "apple" });
  }

  return gpus;
}

export function testEncoderWorking(
  encoderId: string,
  extraArgs: string[] = [],
  customInput?: { width?: number; height?: number; duration?: number; bitDepth?: number },
): Promise<{ ok: boolean; speedMultiplier?: number; fps?: number }> {
  return new Promise((resolve) => {
    const width = customInput?.width ?? 640;
    const height = customInput?.height ?? 360;
    const duration = customInput?.duration ?? 0.8;
    const pixFmt = customInput?.bitDepth === 10 ? "yuv420p10le" : "yuv420p";

    // Generate a dummy clip to test real encoding
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-stats",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=${width}x${height}:rate=30:duration=${duration},format=${pixFmt}`,
      "-c:v",
      encoderId,
      ...extraArgs,
      "-f",
      "null",
      "-",
    ];

    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeoutMs = customInput?.duration ? Math.max(5000, customInput.duration * 10000) : 4000;
    const timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // process may have already exited
      }
      resolve({ ok: false });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        let speed = 1.0;
        let fps: number | undefined;

        const speedMatch = stderr.match(/speed=\s*([\d.]+)x/);
        if (speedMatch && speedMatch[1]) {
          speed = parseFloat(speedMatch[1]);
        }

        const fpsMatch = stderr.match(/fps=\s*([\d.]+)/);
        if (fpsMatch && fpsMatch[1]) {
          fps = parseFloat(fpsMatch[1]);
        }

        resolve({ ok: true, speedMultiplier: speed, fps });
      } else {
        resolve({ ok: false });
      }
    });

    proc.on("error", () => {
      clearTimeout(timeout);
      resolve({ ok: false });
    });
  });
}

const NON_VAAPI_CANDIDATES: {
  id: string;
  name: string;
  codec: "hevc" | "av1" | "h264";
  hwaccelType: "amf" | "qsv" | "nvenc" | "videotoolbox" | "cpu";
  description: string;
  extraArgs?: string[];
}[] = [
  // AMD AMF
  { id: "hevc_amf", name: "AMD AMF HEVC (H.265)", codec: "hevc", hwaccelType: "amf", description: "Hardware accelerated HEVC via AMD AMF" },
  { id: "av1_amf", name: "AMD AMF AV1", codec: "av1", hwaccelType: "amf", description: "Hardware accelerated AV1 via AMD AMF" },
  { id: "h264_amf", name: "AMD AMF H.264", codec: "h264", hwaccelType: "amf", description: "Hardware accelerated H.264 via AMD AMF" },

  // Intel QuickSync
  { id: "hevc_qsv", name: "Intel Quick Sync HEVC", codec: "hevc", hwaccelType: "qsv", description: "Hardware accelerated HEVC via Intel QSV" },
  { id: "av1_qsv", name: "Intel Quick Sync AV1", codec: "av1", hwaccelType: "qsv", description: "Hardware accelerated AV1 via Intel Arc / QSV" },
  { id: "h264_qsv", name: "Intel Quick Sync H.264", codec: "h264", hwaccelType: "qsv", description: "Hardware accelerated H.264 via Intel QSV" },

  // NVIDIA NVENC
  { id: "hevc_nvenc", name: "NVIDIA NVENC HEVC", codec: "hevc", hwaccelType: "nvenc", description: "Hardware accelerated HEVC via NVIDIA GPU" },
  { id: "av1_nvenc", name: "NVIDIA NVENC AV1", codec: "av1", hwaccelType: "nvenc", description: "Hardware accelerated AV1 via NVIDIA RTX 4000+ GPU" },
  { id: "h264_nvenc", name: "NVIDIA NVENC H.264", codec: "h264", hwaccelType: "nvenc", description: "Hardware accelerated H.264 via NVIDIA GPU" },

  // Apple VideoToolbox
  { id: "hevc_videotoolbox", name: "Apple VideoToolbox HEVC", codec: "hevc", hwaccelType: "videotoolbox", description: "Hardware accelerated HEVC via Apple Silicon / VideoToolbox" },
  { id: "h264_videotoolbox", name: "Apple VideoToolbox H.264", codec: "h264", hwaccelType: "videotoolbox", description: "Hardware accelerated H.264 via Apple VideoToolbox" },

  // Software CPU Encoders
  { id: "libx265", name: "Software libx265", codec: "hevc", hwaccelType: "cpu", description: "High-efficiency software HEVC CPU encoding" },
  { id: "libsvtav1", name: "Software SVT-AV1", codec: "av1", hwaccelType: "cpu", description: "Next-generation software AV1 CPU encoding" },
  { id: "libx264", name: "Software libx264", codec: "h264", hwaccelType: "cpu", description: "Standard software H.264 CPU encoding" },
];

const VAAPI_CANDIDATES: {
  id: string;
  name: string;
  codec: "hevc" | "av1" | "h264";
}[] = [
  { id: "h264_vaapi", name: "VAAPI H.264", codec: "h264" },
  { id: "hevc_vaapi", name: "VAAPI HEVC (H.265)", codec: "hevc" },
  { id: "av1_vaapi", name: "VAAPI AV1", codec: "av1" },
];

export async function detectHardware(forceRefresh = false): Promise<HardwareReport> {
  if (cachedReport && !forceRefresh) {
    return cachedReport;
  }

  const gpus = detectGpus();
  const renderNodes = scanRenderNodes();
  const encoders: DetectedEncoder[] = [];

  // 1. Test non-VAAPI encoders (amf, qsv, nvenc, videotoolbox, cpu)
  for (const item of NON_VAAPI_CANDIDATES) {
    if (os.platform() !== "darwin" && item.hwaccelType === "videotoolbox") {
      continue;
    }

    const test = await testEncoderWorking(item.id, item.extraArgs ?? []);
    if (test.ok) {
      encoders.push({
        id: item.id,
        name: item.name,
        codec: item.codec,
        hwaccelType: item.hwaccelType,
        working: true,
        speedMultiplier: test.speedMultiplier,
        fps: test.fps,
        description: item.description,
      });
    }
  }

  // 2. Test VAAPI encoders across each accessible DRM render node
  const workingRenderNodes = renderNodes.filter((n) => n.readable && n.writable);
  if (os.platform() === "linux" && workingRenderNodes.length > 0) {
    for (const node of workingRenderNodes) {
      for (const candidate of VAAPI_CANDIDATES) {
        const extraArgs = ["-vaapi_device", node.path, "-vf", "format=nv12|vaapi,hwupload"];
        const test = await testEncoderWorking(candidate.id, extraArgs);

        if (test.ok) {
          const deviceLabel = node.deviceName || node.driver || node.path;
          encoders.push({
            id: candidate.id,
            name: `${candidate.name} (${deviceLabel})`,
            codec: candidate.codec,
            hwaccelType: "vaapi",
            working: true,
            speedMultiplier: test.speedMultiplier,
            fps: test.fps,
            description: `Hardware accelerated ${candidate.codec.toUpperCase()} via VA-API on ${deviceLabel} (${node.path})`,
            devicePath: node.path,
            deviceName: deviceLabel,
          });
        }
      }
    }
  }

  // 3. Choose the fastest verified hardware candidate per codec (preferring HW over CPU)
  function pickBestCandidate(codec: "hevc" | "av1" | "h264", defaultCpuId: string): RecommendedEncoderSelection {
    const working = encoders.filter((e) => e.codec === codec && e.working);
    const hwList = working.filter((e) => e.hwaccelType !== "cpu");

    if (hwList.length > 0) {
      // Sort by speed multiplier descending (highest speed first)
      hwList.sort((a, b) => (b.speedMultiplier ?? 0) - (a.speedMultiplier ?? 0));
      const best = hwList[0];
      return {
        encoderId: best.id,
        hwaccelType: best.hwaccelType,
        devicePath: best.devicePath,
        deviceName: best.deviceName,
        speedMultiplier: best.speedMultiplier,
      };
    }

    const cpu = working.find((e) => e.hwaccelType === "cpu");
    return {
      encoderId: cpu?.id ?? defaultCpuId,
      hwaccelType: "cpu",
      speedMultiplier: cpu?.speedMultiplier,
    };
  }

  const bestHevc = pickBestCandidate("hevc", "libx265");
  const bestAv1 = pickBestCandidate("av1", "libsvtav1");
  const bestH264 = pickBestCandidate("h264", "libx264");

  const recommendations = {
    hevc: bestHevc,
    av1: bestAv1,
    h264: bestH264,
  };

  const recommendedHevc = bestHevc.encoderId;
  const recommendedAv1 = bestAv1.encoderId;
  const recommendedH264 = bestH264.encoderId;

  const primaryRenderNode = bestHevc.devicePath || bestAv1.devicePath || bestH264.devicePath || workingRenderNodes[0]?.path;

  const hwEncodersCount = encoders.filter((e) => e.hwaccelType !== "cpu").length;
  const summary = hwEncodersCount > 0
    ? (() => {
        const formatEncSummary = (rec: RecommendedEncoderSelection) => {
          const dev = rec.deviceName ? ` (${rec.deviceName})` : "";
          const spd = rec.speedMultiplier ? ` @ ${rec.speedMultiplier.toFixed(1)}x` : "";
          return `${rec.encoderId}${dev}${spd}`;
        };
        return `Hardware GPU acceleration active: HEVC [${formatEncSummary(bestHevc)}], AV1 [${formatEncSummary(bestAv1)}], H.264 [${formatEncSummary(bestH264)}]`;
      })()
    : "Software CPU encoding active (no hardware GPU encoder verified)";

  cachedReport = {
    os: `${os.type()} ${os.release()}`,
    platform: os.platform(),
    gpus,
    renderNodes,
    primaryRenderNode,
    encoders,
    recommendedHevc,
    recommendedAv1,
    recommendedH264,
    recommendations,
    summary,
    testedAt: new Date().toISOString(),
  };

  return cachedReport;
}

export function getCachedHardware(): HardwareReport | undefined {
  return cachedReport;
}

export async function resolveEncoderForPreset(
  targetCodec: "hevc" | "av1" | "h264",
  hwaccelPref: string = "auto",
): Promise<{ encoderId: string; hwaccelType: string; devicePath?: string; deviceName?: string }> {
  const report = await detectHardware();

  if (hwaccelPref === "cpu") {
    if (targetCodec === "hevc") return { encoderId: "libx265", hwaccelType: "cpu" };
    if (targetCodec === "av1") return { encoderId: "libsvtav1", hwaccelType: "cpu" };
    return { encoderId: "libx264", hwaccelType: "cpu" };
  }

  // Explicit hwaccel type requested (e.g. vaapi, qsv, nvenc, amf, videotoolbox)
  if (hwaccelPref !== "auto") {
    const matching = report.encoders
      .filter((e) => e.codec === targetCodec && e.hwaccelType === hwaccelPref && e.working)
      .sort((a, b) => (b.speedMultiplier ?? 0) - (a.speedMultiplier ?? 0));

    if (matching.length > 0) {
      const match = matching[0];
      return {
        encoderId: match.id,
        hwaccelType: match.hwaccelType,
        devicePath: match.devicePath,
        deviceName: match.deviceName,
      };
    }
  }

  // Auto selection - use optimal recommendation
  if (report.recommendations && report.recommendations[targetCodec]) {
    const rec = report.recommendations[targetCodec];
    return {
      encoderId: rec.encoderId,
      hwaccelType: rec.hwaccelType,
      devicePath: rec.devicePath,
      deviceName: rec.deviceName,
    };
  }

  // Fallback to legacy fields
  let recId = report.recommendedHevc;
  if (targetCodec === "av1") recId = report.recommendedAv1;
  else if (targetCodec === "h264") recId = report.recommendedH264;

  const found = report.encoders.find((e) => e.id === recId && e.working);
  return {
    encoderId: recId,
    hwaccelType: found?.hwaccelType ?? (recId.startsWith("lib") ? "cpu" : "auto"),
    devicePath: found?.devicePath || report.primaryRenderNode,
    deviceName: found?.deviceName,
  };
}

