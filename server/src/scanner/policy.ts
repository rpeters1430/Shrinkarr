import type { Preset } from "../config/schema.js";
import type { MediaProbe } from "../media/types.js";

export interface PolicyDecision {
  shouldTranscode: boolean;
  reason: string;
  recommendedAction: string;
  estimatedSavingsPercent: number;
  estimatedSavingsBytes: number;
}

export function getExpectedTargetBitrateKbps(
  resolutionLabel: "4K" | "1440p" | "1080p" | "720p" | "480p" | "SD",
  targetCodec: "hevc" | "h264" | "av1",
  crf: number,
): number {
  let baselineKbps: number;
  let baselineCrf: number;

  switch (targetCodec) {
    case "av1":
      baselineCrf = 28;
      switch (resolutionLabel) {
        case "4K": baselineKbps = 5500; break;
        case "1440p": baselineKbps = 3200; break;
        case "1080p": baselineKbps = 1600; break;
        case "720p": baselineKbps = 800; break;
        case "480p": baselineKbps = 450; break;
        default: baselineKbps = 350; break;
      }
      break;

    case "hevc":
      baselineCrf = 24;
      switch (resolutionLabel) {
        case "4K": baselineKbps = 7500; break;
        case "1440p": baselineKbps = 4200; break;
        case "1080p": baselineKbps = 2200; break;
        case "720p": baselineKbps = 1100; break;
        case "480p": baselineKbps = 600; break;
        default: baselineKbps = 450; break;
      }
      break;

    case "h264":
    default:
      baselineCrf = 22;
      switch (resolutionLabel) {
        case "4K": baselineKbps = 16000; break;
        case "1440p": baselineKbps = 8000; break;
        case "1080p": baselineKbps = 4000; break;
        case "720p": baselineKbps = 2000; break;
        case "480p": baselineKbps = 1000; break;
        default: baselineKbps = 750; break;
      }
      break;
  }

  // Adjust for CRF: approximately +6 CRF halves bitrate, -6 doubles it
  const crfDelta = baselineCrf - crf;
  const factor = Math.pow(2, crfDelta / 6);
  return Math.round(baselineKbps * factor);
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

  let theoreticalSavings = 10;
  if (target === "av1") {
    if (src === "hevc" || src === "h265") theoreticalSavings = 25;
    else if (src === "h264" || src === "avc") theoreticalSavings = 48;
    else if (src === "mpeg2video" || src === "vc1" || src === "msmpeg4v3") theoreticalSavings = 70;
    else theoreticalSavings = 35;
  } else if (target === "hevc") {
    if (src === "h264" || src === "avc") {
      // 4K H.264 typically has huge savings in HEVC 10-bit
      if (probe.resolutionLabel === "4K") theoreticalSavings = 45;
      else if (probe.resolutionLabel === "1080p") theoreticalSavings = 38;
      else theoreticalSavings = 32;
    } else if (src === "mpeg2video" || src === "vc1" || src === "wmv3") {
      theoreticalSavings = 65;
    } else {
      theoreticalSavings = 25;
    }
  } else if (target === "h264") {
    if (src === "mpeg2video" || src === "vc1") theoreticalSavings = 45;
    else theoreticalSavings = 0;
  }

  // If probe bitrate is known, determine whether the source file is already at or below
  // the expected target bitrate. If so, re-encoding will not save space and would cause file bloat.
  if (probe.bitrateKbps > 0) {
    const expectedTarget = getExpectedTargetBitrateKbps(
      probe.resolutionLabel,
      preset.targetCodec,
      preset.crf ?? 24,
    );
    if (probe.bitrateKbps <= expectedTarget) {
      return 0;
    }
    const bitrateSavings = Math.round((1 - expectedTarget / probe.bitrateKbps) * 100);
    return Math.max(0, Math.min(theoreticalSavings, bitrateSavings));
  }

  return theoreticalSavings;
}

export interface LibraryPolicyContext {
  mediaType?: "movie" | "tv" | "youtube" | "web" | "music" | "other";
  minFileSizeMb?: number;
}

// Estimated space savings from re-encoding a music file's audio stream.
// Lossless sources (FLAC/ALAC/WAV/...) compress heavily against a lossy target
// bitrate; a lossy source is only re-bitrated down when the preset explicitly
// allows it (onlyIfLosslessSource: false), and only if it's already above target.
export function estimateMusicSavingsPercent(probe: MediaProbe, preset: Preset): number {
  if (probe.isLosslessAudio) {
    if (probe.bitrateKbps > 0) {
      const pct = Math.round((1 - preset.targetAudioBitrateKbps / probe.bitrateKbps) * 100);
      return Math.max(0, Math.min(95, pct));
    }
    // No reliable bitrate on the probe (rare); a CD-quality FLAC vs. a modern
    // lossy target is reliably a large win, so assume a conservative default.
    return 75;
  }

  if (probe.bitrateKbps > preset.targetAudioBitrateKbps) {
    return Math.round((1 - preset.targetAudioBitrateKbps / probe.bitrateKbps) * 100);
  }
  return 0;
}

function decideMusic(
  probe: MediaProbe,
  preset: Preset,
  library?: LibraryPolicyContext,
): PolicyDecision {
  if (preset.onlyIfLosslessSource && !probe.isLosslessAudio) {
    return {
      shouldTranscode: false,
      reason: "lossy source kept as-is (preset only touches lossless sources)",
      recommendedAction: "Keep",
      estimatedSavingsPercent: 0,
      estimatedSavingsBytes: 0,
    };
  }

  if (preset.skipAlreadyTarget && probe.audioCodec.toLowerCase() === preset.targetAudioCodec) {
    return {
      shouldTranscode: false,
      reason: "already target audio codec",
      recommendedAction: "Keep",
      estimatedSavingsPercent: 0,
      estimatedSavingsBytes: 0,
    };
  }

  const effectiveMinFileSizeMb = library?.minFileSizeMb ?? preset.minFileSizeMb ?? 5;
  const fileSizeMb = probe.sizeBytes / (1024 * 1024);
  if (effectiveMinFileSizeMb > 0 && fileSizeMb < effectiveMinFileSizeMb) {
    return {
      shouldTranscode: false,
      reason: `file size (${fileSizeMb.toFixed(1)}MB) is below threshold (${effectiveMinFileSizeMb}MB)`,
      recommendedAction: "Keep",
      estimatedSavingsPercent: 0,
      estimatedSavingsBytes: 0,
    };
  }

  const savingsPercent = estimateMusicSavingsPercent(probe, preset);
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

  return {
    shouldTranscode: true,
    reason: "eligible",
    recommendedAction: preset.targetAudioCodec.toUpperCase(),
    estimatedSavingsPercent: savingsPercent,
    estimatedSavingsBytes,
  };
}

export function decide(
  probe: MediaProbe,
  preset: Preset,
  library?: LibraryPolicyContext,
): PolicyDecision {
  if (preset.mediaKind === "audio" || probe.mediaKind === "audio") {
    return decideMusic(probe, preset, library);
  }

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

  // Determine effective minimum file size threshold:
  // 1. Explicit library override (library.minFileSizeMb)
  // 2. Non-movie/non-tv media types ("other", "youtube", "web") default to a lower threshold (e.g. 25MB or preset if lower)
  // 3. Preset-defined minFileSizeMb (default 500MB, intended for movies and TV shows)
  let effectiveMinFileSizeMb = preset.minFileSizeMb ?? 500;
  if (library?.minFileSizeMb !== undefined) {
    effectiveMinFileSizeMb = library.minFileSizeMb;
  } else if (
    library?.mediaType === "other" ||
    library?.mediaType === "youtube" ||
    library?.mediaType === "web"
  ) {
    effectiveMinFileSizeMb = Math.min(effectiveMinFileSizeMb, 25);
  }

  const fileSizeMb = probe.sizeBytes / (1024 * 1024);
  if (effectiveMinFileSizeMb > 0 && fileSizeMb < effectiveMinFileSizeMb) {
    return {
      shouldTranscode: false,
      reason: `file size (${fileSizeMb.toFixed(0)}MB) is below threshold (${effectiveMinFileSizeMb}MB)`,
      recommendedAction: "Keep",
      estimatedSavingsPercent: 0,
      estimatedSavingsBytes: 0,
    };
  }

  const savingsPercent = estimateSavingsPercent(probe, preset);
  const estimatedSavingsBytes = Math.round((probe.sizeBytes * savingsPercent) / 100);

  if (savingsPercent < preset.minSavingsPercent) {
    const reason = savingsPercent <= 0 && probe.bitrateKbps > 0
      ? `source bitrate (${probe.bitrateKbps} kbps) is already too low for further savings without quality degradation`
      : `estimated savings (${savingsPercent}%) below threshold (${preset.minSavingsPercent}%)`;
    return {
      shouldTranscode: false,
      reason,
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
