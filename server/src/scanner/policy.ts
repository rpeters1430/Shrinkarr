import type { Preset } from "../config/schema.js";
import type { MediaProbe } from "../media/types.js";

export interface PolicyDecision {
  shouldTranscode: boolean;
  reason: string;
}

/**
 * Rough heuristic for how much smaller a re-encode would be, used to skip
 * files where a transcode wouldn't be worth the CPU/GPU time. h264 -> hevc
 * typically yields ~35% smaller output at comparable quality; h264 -> h264
 * or hevc -> hevc at a different CRF is assumed to yield negligible savings
 * since we don't re-measure quality here.
 */
function estimateSavingsPercent(probe: MediaProbe, preset: Preset): number {
  if (probe.videoCodec === preset.targetCodec) {
    return 0;
  }
  if (probe.videoCodec === "h264" && preset.targetCodec === "hevc") {
    return 35;
  }
  return 10;
}

export function decide(probe: MediaProbe, preset: Preset): PolicyDecision {
  if (probe.videoCodec === preset.targetCodec) {
    return { shouldTranscode: false, reason: "already target codec" };
  }

  const estimatedSavings = estimateSavingsPercent(probe, preset);
  if (estimatedSavings < preset.minSavingsPercent) {
    return { shouldTranscode: false, reason: "below savings threshold" };
  }

  return { shouldTranscode: true, reason: "eligible" };
}
