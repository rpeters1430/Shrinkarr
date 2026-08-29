import { statSync } from "node:fs";
import { probeFile } from "../media/ffprobe.js";
import type { MediaProbe } from "../media/types.js";

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export async function verifyOutput(
  originalProbe: MediaProbe,
  outputPath: string,
): Promise<VerifyResult> {
  let sizeBytes: number;
  try {
    sizeBytes = statSync(outputPath).size;
  } catch (err) {
    return { ok: false, reason: `Output file missing: ${(err as Error).message}` };
  }

  if (sizeBytes === 0) {
    return { ok: false, reason: "Output file is empty" };
  }

  let outputProbe;
  try {
    outputProbe = await probeFile(outputPath);
  } catch (err) {
    return { ok: false, reason: `Failed to probe output: ${(err as Error).message}` };
  }

  if (!outputProbe.videoCodec) {
    return { ok: false, reason: "Output has no video stream" };
  }

  // Allow 5s or 2% tolerance across different container muxers (MKV/MP4 audio priming & timestamps)
  const maxAllowedDelta = Math.max(5.0, originalProbe.durationSeconds * 0.02);
  const durationDelta = Math.abs(outputProbe.durationSeconds - originalProbe.durationSeconds);
  if (durationDelta > maxAllowedDelta) {
    return {
      ok: false,
      reason: `Duration mismatch: original ${originalProbe.durationSeconds}s vs output ${outputProbe.durationSeconds}s (delta ${durationDelta.toFixed(1)}s > ${maxAllowedDelta.toFixed(1)}s)`,
    };
  }

  return { ok: true };
}
