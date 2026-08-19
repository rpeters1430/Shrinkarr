import { execSync, spawn } from "node:child_process";
import os from "node:os";

export interface DetectedGpu {
  name: string;
  vendor: "nvidia" | "intel" | "amd" | "apple" | "other";
  driverVersion?: string;
}

export interface DetectedEncoder {
  id: string;
  name: string;
  codec: "hevc" | "av1" | "h264";
  hwaccelType: "amf" | "qsv" | "nvenc" | "vaapi" | "videotoolbox" | "cpu";
  working: boolean;
  speedMultiplier?: number;
  description: string;
}

export interface HardwareReport {
  os: string;
  platform: NodeJS.Platform;
  gpus: DetectedGpu[];
  encoders: DetectedEncoder[];
  recommendedHevc: string;
  recommendedAv1: string;
  recommendedH264: string;
  summary: string;
  testedAt: string;
}

let cachedReport: HardwareReport | undefined;

function runCommandSafe(cmd: string): string {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8", timeout: 4000 });
  } catch {
    return "";
  }
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
    const lspci = runCommandSafe("lspci");
    for (const line of lspci.split("\n")) {
      if (line.includes("VGA") || line.includes("3D") || line.includes("Display")) {
        let vendor: DetectedGpu["vendor"] = "other";
        const lower = line.toLowerCase();
        if (lower.includes("nvidia")) vendor = "nvidia";
        else if (lower.includes("intel")) vendor = "intel";
        else if (lower.includes("amd") || lower.includes("radeon") || lower.includes("advanced micro devices")) vendor = "amd";
        gpus.push({ name: line.trim(), vendor });
      }
    }
  } else if (platform === "darwin") {
    gpus.push({ name: "Apple Silicon / VideoToolbox", vendor: "apple" });
  }

  return gpus;
}

export function testEncoderWorking(encoderId: string, extraArgs: string[] = []): Promise<{ ok: boolean; speedMultiplier?: number }> {
  return new Promise((resolve) => {
    // Generate a 0.5-second dummy clip to test real encoding
    const args = [
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=640x360:d=0.5",
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

    const timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
      resolve({ ok: false });
    }, 4000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        let speed = 1.0;
        const speedMatch = stderr.match(/speed=\s*([\d.]+)x/);
        if (speedMatch && speedMatch[1]) {
          speed = parseFloat(speedMatch[1]);
        }
        resolve({ ok: true, speedMultiplier: speed });
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

const CANDIDATE_ENCODERS: {
  id: string;
  name: string;
  codec: "hevc" | "av1" | "h264";
  hwaccelType: "amf" | "qsv" | "nvenc" | "vaapi" | "videotoolbox" | "cpu";
  description: string;
  extraArgs?: string[];
}[] = [
  // AMD AMF
  { id: "hevc_amf", name: "AMD AMF HEVC (H.265)", codec: "hevc", hwaccelType: "amf", description: "Hardware accelerated HEVC via AMD Radeon GPU" },
  { id: "av1_amf", name: "AMD AMF AV1", codec: "av1", hwaccelType: "amf", description: "Hardware accelerated AV1 via modern AMD Radeon GPU" },
  { id: "h264_amf", name: "AMD AMF H.264", codec: "h264", hwaccelType: "amf", description: "Hardware accelerated H.264 via AMD Radeon GPU" },

  // Intel QuickSync
  { id: "hevc_qsv", name: "Intel Quick Sync HEVC", codec: "hevc", hwaccelType: "qsv", description: "Hardware accelerated HEVC via Intel QSV" },
  { id: "av1_qsv", name: "Intel Quick Sync AV1", codec: "av1", hwaccelType: "qsv", description: "Hardware accelerated AV1 via Intel Arc / QSV" },
  { id: "h264_qsv", name: "Intel Quick Sync H.264", codec: "h264", hwaccelType: "qsv", description: "Hardware accelerated H.264 via Intel QSV" },

  // NVIDIA NVENC
  { id: "hevc_nvenc", name: "NVIDIA NVENC HEVC", codec: "hevc", hwaccelType: "nvenc", description: "Hardware accelerated HEVC via NVIDIA GPU" },
  { id: "av1_nvenc", name: "NVIDIA NVENC AV1", codec: "av1", hwaccelType: "nvenc", description: "Hardware accelerated AV1 via NVIDIA RTX 4000+ GPU" },
  { id: "h264_nvenc", name: "NVIDIA NVENC H.264", codec: "h264", hwaccelType: "nvenc", description: "Hardware accelerated H.264 via NVIDIA GPU" },

  // Linux VAAPI
  { id: "hevc_vaapi", name: "VAAPI HEVC", codec: "hevc", hwaccelType: "vaapi", description: "Hardware accelerated HEVC via Linux VAAPI", extraArgs: ["-vaapi_device", "/dev/dri/renderD128", "-vf", "format=nv12|vaapi,hwupload"] },
  { id: "av1_vaapi", name: "VAAPI AV1", codec: "av1", hwaccelType: "vaapi", description: "Hardware accelerated AV1 via Linux VAAPI", extraArgs: ["-vaapi_device", "/dev/dri/renderD128", "-vf", "format=nv12|vaapi,hwupload"] },
  { id: "h264_vaapi", name: "VAAPI H.264", codec: "h264", hwaccelType: "vaapi", description: "Hardware accelerated H.264 via Linux VAAPI", extraArgs: ["-vaapi_device", "/dev/dri/renderD128", "-vf", "format=nv12|vaapi,hwupload"] },

  // Apple VideoToolbox
  { id: "hevc_videotoolbox", name: "Apple VideoToolbox HEVC", codec: "hevc", hwaccelType: "videotoolbox", description: "Hardware accelerated HEVC via Apple Silicon / VideoToolbox" },
  { id: "h264_videotoolbox", name: "Apple VideoToolbox H.264", codec: "h264", hwaccelType: "videotoolbox", description: "Hardware accelerated H.264 via Apple VideoToolbox" },

  // CPU
  { id: "libx265", name: "Software libx265", codec: "hevc", hwaccelType: "cpu", description: "High-efficiency software HEVC CPU encoding" },
  { id: "libsvtav1", name: "Software SVT-AV1", codec: "av1", hwaccelType: "cpu", description: "Next-generation software AV1 CPU encoding" },
  { id: "libx264", name: "Software libx264", codec: "h264", hwaccelType: "cpu", description: "Standard software H.264 CPU encoding" },
];

export async function detectHardware(forceRefresh = false): Promise<HardwareReport> {
  if (cachedReport && !forceRefresh) {
    return cachedReport;
  }

  const gpus = detectGpus();
  const encoders: DetectedEncoder[] = [];

  for (const item of CANDIDATE_ENCODERS) {
    // Only test if candidates make sense for OS
    if (os.platform() !== "linux" && item.hwaccelType === "vaapi") {
      continue;
    }
    if (os.platform() !== "darwin" && item.hwaccelType === "videotoolbox") {
      continue;
    }

    const test = await testEncoderWorking(item.id, item.extraArgs);
    if (test.ok) {
      encoders.push({
        id: item.id,
        name: item.name,
        codec: item.codec,
        hwaccelType: item.hwaccelType,
        working: true,
        speedMultiplier: test.speedMultiplier,
        description: item.description,
      });
    }
  }

  // Determine best recommended encoders
  const workingHevc = encoders.filter((e) => e.codec === "hevc");
  const workingAv1 = encoders.filter((e) => e.codec === "av1");
  const workingH264 = encoders.filter((e) => e.codec === "h264");

  // Priority order for HW: amf/qsv/nvenc/vaapi/videotoolbox > cpu
  function pickBest(list: DetectedEncoder[], defaultId: string): string {
    const hw = list.find((e) => e.hwaccelType !== "cpu");
    if (hw) return hw.id;
    const cpu = list.find((e) => e.hwaccelType === "cpu");
    if (cpu) return cpu.id;
    return defaultId;
  }

  const recommendedHevc = pickBest(workingHevc, "libx265");
  const recommendedAv1 = pickBest(workingAv1, "libsvtav1");
  const recommendedH264 = pickBest(workingH264, "libx264");

  const activeGpuNames = gpus.map((g) => g.name).join(", ");
  const hwEncodersCount = encoders.filter((e) => e.hwaccelType !== "cpu").length;
  const summary = hwEncodersCount > 0
    ? `${hwEncodersCount} hardware encoder(s) active (${activeGpuNames || "GPU acceleration detected"})`
    : "Software CPU encoding active (no hardware GPU encoder verified)";

  cachedReport = {
    os: `${os.type()} ${os.release()}`,
    platform: os.platform(),
    gpus,
    encoders,
    recommendedHevc,
    recommendedAv1,
    recommendedH264,
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
): Promise<{ encoderId: string; hwaccelType: string }> {
  const report = await detectHardware();

  if (hwaccelPref === "cpu") {
    if (targetCodec === "hevc") return { encoderId: "libx265", hwaccelType: "cpu" };
    if (targetCodec === "av1") return { encoderId: "libsvtav1", hwaccelType: "cpu" };
    return { encoderId: "libx264", hwaccelType: "cpu" };
  }

  // Explicit hwaccel type requested
  if (hwaccelPref !== "auto") {
    const match = report.encoders.find(
      (e) => e.codec === targetCodec && e.hwaccelType === hwaccelPref,
    );
    if (match) {
      return { encoderId: match.id, hwaccelType: match.hwaccelType };
    }
  }

  // Auto pick best
  let recId = report.recommendedHevc;
  if (targetCodec === "av1") recId = report.recommendedAv1;
  else if (targetCodec === "h264") recId = report.recommendedH264;

  const found = report.encoders.find((e) => e.id === recId);
  return {
    encoderId: recId,
    hwaccelType: found?.hwaccelType ?? (recId.startsWith("lib") ? "cpu" : "auto"),
  };
}
