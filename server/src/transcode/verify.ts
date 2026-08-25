import { statSync } from "node:fs";
import { probeFile } from "../media/ffprobe.js";
import type { MediaProbe } from "../media/types.js";

const DURATION_TOLERANCE_SECONDS = 1.0;

export interface VerifyOptions {
  /** Preset copied audio streams verbatim; a track/channel count drop means something broke. */
  audioCopied?: boolean;
  /** Preset copied subtitle streams verbatim; a track count drop means something broke. */
  subtitlesCopied?: boolean;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export async function verifyOutput(
  originalProbe: MediaProbe,
  outputPath: string,
  options: VerifyOptions = {},
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

  if (originalProbe.sizeBytes > 0 && sizeBytes >= originalProbe.sizeBytes) {
    return {
      ok: false,
      reason: `Output (${sizeBytes} bytes) is not smaller than the original (${originalProbe.sizeBytes} bytes); refusing to replace`,
    };
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

  if (options.audioCopied && originalProbe.audioTrackCount > 0) {
    if (outputProbe.audioTrackCount !== originalProbe.audioTrackCount) {
      return {
        ok: false,
        reason: `Audio track count mismatch: original ${originalProbe.audioTrackCount} vs output ${outputProbe.audioTrackCount} (audio was set to copy)`,
      };
    }
    if (outputProbe.audioChannels !== originalProbe.audioChannels) {
      return {
        ok: false,
        reason: `Audio channel count mismatch: original ${originalProbe.audioChannels}ch vs output ${outputProbe.audioChannels}ch (audio was set to copy)`,
      };
    }
  }

  if (options.subtitlesCopied && outputProbe.subtitleCount !== originalProbe.subtitleCount) {
    return {
      ok: false,
      reason: `Subtitle track count mismatch: original ${originalProbe.subtitleCount} vs output ${outputProbe.subtitleCount} (subtitles were set to copy)`,
    };
  }

  return { ok: true };
}
