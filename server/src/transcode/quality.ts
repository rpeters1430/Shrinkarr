import { execFile, spawn } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { trackProcess } from "./runner.js";

const execFileAsync = promisify(execFile);

export type QualityMetric = "vmaf" | "ssim";

export interface QualityMetricSupport {
  vmaf: boolean;
  ssim: boolean;
}

// Sample windows, as fractions of the duration. Scoring three short clips
// instead of the whole file keeps a 2-hour movie's check to about a minute.
const SAMPLE_POSITIONS = [0.15, 0.5, 0.85];
const SAMPLE_SECONDS = 10;

let supportCache: Promise<QualityMetricSupport> | undefined;

export function parseQualityFilters(filtersOutput: string): QualityMetricSupport {
  // Lines look like " ... libvmaf           VV->V      Calculate the VMAF ..."
  const names = new Set(
    filtersOutput.split("\n").map((line) => line.trim().split(/\s+/)[1]).filter(Boolean),
  );
  return { vmaf: names.has("libvmaf"), ssim: names.has("ssim") };
}

export function detectQualityMetrics(forceRefresh = false): Promise<QualityMetricSupport> {
  if (!supportCache || forceRefresh) {
    supportCache = execFileAsync("ffmpeg", ["-hide_banner", "-filters"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })
      .then(({ stdout }) => parseQualityFilters(stdout))
      .catch(() => ({ vmaf: false, ssim: false }));
  }
  return supportCache;
}

export function parseQualityScore(metric: QualityMetric, stderr: string): number | undefined {
  const match = metric === "vmaf"
    ? stderr.match(/VMAF score[:=]\s*([\d.]+)/)
    : stderr.match(/SSIM [^\n]*All:([\d.]+)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/** Start times of the sample clips; one clip covering the whole file when it is short. */
export function sampleWindows(durationSeconds: number): Array<{ start: number; length: number }> {
  if (!(durationSeconds > 0) || durationSeconds <= SAMPLE_SECONDS * SAMPLE_POSITIONS.length * 1.5) {
    return [{ start: 0, length: Math.max(durationSeconds, 1) }];
  }
  return SAMPLE_POSITIONS.map((position) => ({
    start: Math.max(0, Math.min(durationSeconds * position, durationSeconds - SAMPLE_SECONDS)),
    length: SAMPLE_SECONDS,
  }));
}

export function buildQualityArgs(
  metric: QualityMetric,
  sourcePath: string,
  outputPath: string,
  window: { start: number; length: number },
  options: { width?: number; height?: number; threads?: number } = {},
): string[] {
  const seek = (path: string) => ["-ss", window.start.toFixed(3), "-t", window.length.toFixed(3), "-i", path];
  // Both metrics need frames of equal size and format. The encode keeps the
  // source resolution, so the scale only guards against odd crop rounding.
  const scale = options.width && options.height ? `,scale=${options.width}:${options.height}:flags=bicubic` : "";
  const threads = options.threads && options.threads > 0 ? options.threads : Math.max(1, os.cpus().length);
  const compare = metric === "vmaf" ? `libvmaf=n_threads=${threads}` : "ssim";
  return [
    "-hide_banner",
    "-nostats",
    ...seek(outputPath),
    ...seek(sourcePath),
    // libvmaf and ssim both take the encoded (distorted) stream first.
    "-lavfi",
    `[0:v:0]setpts=PTS-STARTPTS${scale},format=yuv420p[dist];[1:v:0]setpts=PTS-STARTPTS${scale},format=yuv420p[ref];[dist][ref]${compare}`,
    "-f",
    "null",
    "-",
  ];
}

function runFfmpeg(args: string[], lowPriority: boolean, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Quality check aborted"));
      return;
    }
    const proc = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    trackProcess(proc);
    if (lowPriority && proc.pid) {
      try {
        os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // ignore priority adjustments
      }
    }
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      // The score is printed at the very end; keep a bounded tail.
      stderr = (stderr + chunk.toString()).slice(-64 * 1024);
    });
    const onAbort = () => proc.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    proc.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });
    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(new Error("Quality check aborted"));
      } else if (code !== 0) {
        const lastLines = stderr.trim().split("\n").slice(-2).join(" ");
        reject(new Error(`ffmpeg exited with code ${code}: ${lastLines}`));
      } else {
        resolve(stderr);
      }
    });
  });
}

export interface QualityMeasureOptions {
  durationSeconds: number;
  width?: number;
  height?: number;
  threads?: number;
  lowPriority?: boolean;
  signal?: AbortSignal;
}

/**
 * Scores the encode against the source on a few sample clips and returns the
 * lowest clip score, so one badly damaged scene can't hide behind good ones.
 * VMAF is 0-100; SSIM is 0-1.
 */
export async function measureQuality(
  metric: QualityMetric,
  sourcePath: string,
  outputPath: string,
  options: QualityMeasureOptions,
): Promise<number> {
  let lowest = Infinity;
  for (const window of sampleWindows(options.durationSeconds)) {
    const args = buildQualityArgs(metric, sourcePath, outputPath, window, options);
    const stderr = await runFfmpeg(args, options.lowPriority !== false, options.signal);
    const score = parseQualityScore(metric, stderr);
    if (score === undefined) {
      throw new Error(`ffmpeg finished without reporting a ${metric.toUpperCase()} score`);
    }
    lowest = Math.min(lowest, score);
  }
  return lowest;
}
