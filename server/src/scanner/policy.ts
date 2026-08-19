import type { Preset } from "../config/schema.js";
import type { MediaProbe } from "../media/types.js";

export interface PolicyDecision {
  shouldTranscode: boolean;
  reason: string;
  recommendedAction: string;
  estimatedSavingsPercent: number;
  estimatedSavingsBytes: number;
}

export function estimateSavingsPercent(probe: MediaProbe, preset: Preset): number {
  const src = probe.videoCodec.toLowerCase();
  const target = preset.targetCodec.toLowerCase();

  if (src === target) {
    return 0;
  }

  // Already modern / high efficiency
  if ((src === "hevc" || src === "h265") && target === "hevc") return 0;
  if (src === "av1" && (target === "hevc" || target === "av1")) return 0;
  if (src === "vp9" && target === "hevc") return 5;

  if (target === "av1") {
    if (src === "hevc" || src === "h265") return 25;
    if (src === "h264" || src === "avc") return 48;
    if (src === "mpeg2video" || src === "vc1" || src === "msmpeg4v3") return 70;
    return 35;
  }

  // Target is HEVC
  if (target === "hevc") {
    if (src === "h264" || src === "avc") {
      // 4K H.264 typically has huge savings in HEVC 10-bit
      if (probe.resolutionLabel === "4K") return 45;
      if (probe.resolutionLabel === "1080p") return 38;
      return 32;
    }
    if (src === "mpeg2video" || src === "vc1" || src === "wmv3") return 65;
    return 25;
  }

  // Target is H.264
  if (target === "h264") {
    if (src === "mpeg2video" || src === "vc1") return 45;
    return 0;
  }

  return 10;
}

export function decide(probe: MediaProbe, preset: Preset): PolicyDecision {
  const src = probe.videoCodec.toLowerCase();
  const target = preset.targetCodec.toLowerCase();

  if (preset.skipAlreadyTarget && (src === target || (src === "h265" && target === "hevc") || (src === "av1" && target === "hevc"))) {
    return {
      shouldTranscode: false,
      reason: "already target / efficient codec",
      recommendedAction: "Keep",
      estimatedSavingsPercent: 0,
      estimatedSavingsBytes: 0,
    };
  }

  const fileSizeMb = probe.sizeBytes / (1024 * 1024);
  if (preset.minFileSizeMb && fileSizeMb < preset.minFileSizeMb) {
    return {
      shouldTranscode: false,
      reason: `file size (${fileSizeMb.toFixed(0)}MB) is below threshold (${preset.minFileSizeMb}MB)`,
      recommendedAction: "Keep",
      estimatedSavingsPercent: 0,
      estimatedSavingsBytes: 0,
    };
  }

  const savingsPercent = estimateSavingsPercent(probe, preset);
  const estimatedSavingsBytes = Math.round((probe.sizeBytes * savingsPercent) / 100);

  if (savingsPercent < preset.minSavingsPercent) {
    return {
      shouldTranscode: false,
      reason: `estimated savings (${savingsPercent}%) below threshold (${preset.minSavingsPercent}%)`,
      recommendedAction: "Keep",
      estimatedSavingsPercent: savingsPercent,
      estimatedSavingsBytes,
    };
  }

  const actionName = target === "hevc" ? "HEVC" : target === "av1" ? "AV1" : "H.264";
  return {
    shouldTranscode: true,
    reason: "eligible",
    recommendedAction: actionName,
    estimatedSavingsPercent: savingsPercent,
    estimatedSavingsBytes,
  };
}
