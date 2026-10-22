import { hwDecodeFailureLine, vaapiDecodeArgs } from "./hwDecode.js";
import { runTranscode } from "./runner.js";

export interface VideoQualityGateOptions {
  minimumSsim: number;
  sourceWidth: number;
  sourceHeight: number;
  sourceVideoDurationSeconds?: number;
  outputVideoDurationSeconds?: number;
  frameRate: number;
  signal?: AbortSignal;
  lowPriority?: boolean;
  onLog?: (text: string) => void;
  // VAAPI render node to decode both files on. SSIM itself always runs on the
  // CPU; without a device the decode does too.
  hwDecodeDevice?: string;
}

export interface VideoQualityGateResult {
  ok: boolean;
  score: number | null;
  reason?: string;
}

export function parseSsimScore(stderr: string): number | null {
  const matches = [...stderr.matchAll(/\bSSIM\s+Y:[^\r\n]*?\bAll:([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/gi)];
  const raw = matches.at(-1)?.[1];
  if (raw === undefined) return null;
  const score = Number(raw);
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : null;
}

export function buildSsimArgs(sourcePath: string, outputPath: string, sourceWidth: number, sourceHeight: number, hwDecodeDevice?: string): string[] {
  const hw = hwDecodeDevice ? vaapiDecodeArgs(hwDecodeDevice) : [];
  return [
    ...hw, "-i", sourcePath,
    ...hw, "-i", outputPath,
    "-filter_complex",
    `[1:v:0]setpts=PTS-STARTPTS,scale=${sourceWidth}:${sourceHeight}:flags=bicubic[dist];[0:v:0]setpts=PTS-STARTPTS[ref];[ref][dist]ssim=shortest=1`,
    "-an", "-sn", "-f", "null", "-",
  ];
}

export async function runVideoQualityGate(
  sourcePath: string,
  outputPath: string,
  durationSeconds: number,
  options: VideoQualityGateOptions,
): Promise<VideoQualityGateResult> {
  if (!Number.isInteger(options.sourceWidth) || options.sourceWidth <= 0
    || !Number.isInteger(options.sourceHeight) || options.sourceHeight <= 0) {
    return { ok: false, score: null, reason: "Source video dimensions are unavailable for SSIM comparison" };
  }
  const { sourceVideoDurationSeconds, outputVideoDurationSeconds } = options;
  if (!Number.isFinite(sourceVideoDurationSeconds) || !sourceVideoDurationSeconds || !Number.isFinite(outputVideoDurationSeconds) || !outputVideoDurationSeconds) {
    return { ok: false, score: null, reason: "Source or output video-stream duration is unavailable for SSIM comparison" };
  }
  const durationTolerance = Math.max(0.1, options.frameRate > 0 ? 2 / options.frameRate : 0);
  if (Math.abs(sourceVideoDurationSeconds - outputVideoDurationSeconds) > durationTolerance) {
    return {
      ok: false,
      score: null,
      reason: `Video duration mismatch: source ${sourceVideoDurationSeconds.toFixed(3)}s vs output ${outputVideoDurationSeconds.toFixed(3)}s`,
    };
  }
  const measure = (device?: string) => runTranscode(
    buildSsimArgs(sourcePath, outputPath, options.sourceWidth, options.sourceHeight, device),
    durationSeconds,
    () => undefined,
    { signal: options.signal, lowPriority: options.lowPriority, onLog: options.onLog },
  );
  const device = options.hwDecodeDevice;
  let stderr: string;
  try {
    stderr = await measure(device);
  } catch (err) {
    const line = device && !options.signal?.aborted ? hwDecodeFailureLine((err as Error).message.split(/\r?\n/)) : undefined;
    if (!device || !line) throw err;
    const note = `GPU decode on ${device} failed (${line}); falling back to CPU decode for the SSIM check`;
    console.warn(`[Quality gate] ${note}: "${sourcePath}"`);
    options.onLog?.(note);
    stderr = await measure();
  }
  const score = parseSsimScore(stderr);
  if (score === null) {
    return { ok: false, score: null, reason: "FFmpeg did not produce a valid SSIM score" };
  }
  if (score < options.minimumSsim) {
    return { ok: false, score, reason: `SSIM ${score.toFixed(5)} is below the minimum ${options.minimumSsim.toFixed(5)}` };
  }
  return { ok: true, score };
}
