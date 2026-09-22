import { stat } from "node:fs/promises";
import { probeFile } from "../media/ffprobe.js";
import type { MediaProbe } from "../media/types.js";

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export interface VerifyOptions {
  enforceSizeReduction?: boolean;
}

export async function verifyOutput(
  originalProbe: MediaProbe,
  outputPath: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  let sizeBytes: number;
  try {
    const fileStat = await stat(outputPath);
    sizeBytes = fileStat.size;
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

  // Stream presence guard: verify required stream types are preserved in output
  const sourceIsAudioOnly = originalProbe.mediaKind === "audio" || (originalProbe.videoCodec === "none" && !originalProbe.width && !originalProbe.height);

  if (!sourceIsAudioOnly) {
    if (!outputProbe.videoCodec || outputProbe.videoCodec === "none") {
      return { ok: false, reason: "Output has no video stream" };
    }
  }

  // Audio preservation guard: If source file had audio, output MUST also have audio
  const sourceHadAudio = (originalProbe.audioChannels !== undefined && originalProbe.audioChannels > 0)
    || (originalProbe.audioCodec && originalProbe.audioCodec !== "none" && originalProbe.audioCodec !== "unknown");

  if (sourceHadAudio) {
    const outputHasAudio = (outputProbe.audioChannels !== undefined && outputProbe.audioChannels > 0)
      || (outputProbe.audioCodec && outputProbe.audioCodec !== "none" && outputProbe.audioCodec !== "unknown");

    if (!outputHasAudio) {
      return {
        ok: false,
        reason: `Audio stream lost during transcode: source had audio (${originalProbe.audioCodec}, ${originalProbe.audioChannels ?? "?"}ch) but output has no audio stream`,
      };
    }
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

  // Size reduction guard: an optimizer must never produce a file larger than the source
  if (options.enforceSizeReduction && originalProbe.sizeBytes > 0 && sizeBytes >= originalProbe.sizeBytes) {
    const originalMb = (originalProbe.sizeBytes / (1024 * 1024)).toFixed(1);
    const outputMb = (sizeBytes / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      reason: `Output file is larger than original (${outputMb}MB vs ${originalMb}MB original); rejecting to prevent size increase`,
    };
  }

  return { ok: true };
}
