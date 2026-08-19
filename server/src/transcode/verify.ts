import { statSync } from "node:fs";
import { probeFile } from "../media/ffprobe.js";
import type { MediaProbe } from "../media/types.js";

const DURATION_TOLERANCE_SECONDS = 1.0;

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

  const durationDelta = Math.abs(outputProbe.durationSeconds - originalProbe.durationSeconds);
  if (durationDelta > DURATION_TOLERANCE_SECONDS) {
    return {
      ok: false,
      reason: `Duration mismatch: original ${originalProbe.durationSeconds}s vs output ${outputProbe.durationSeconds}s`,
    };
  }

  return { ok: true };
}
