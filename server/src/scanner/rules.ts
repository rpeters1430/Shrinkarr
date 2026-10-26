import { relative, isAbsolute, sep } from "node:path";
import picomatch from "picomatch";
import type { Library, Preset } from "../config/schema.js";
import type { FileRecord } from "../db/filesRepo.js";
import type { MediaProbe, PolicyMetadata } from "../media/types.js";
import { decide, type PolicyDecision } from "./policy.js";

export interface RuleResolution {
  status: "ready" | "needsScan" | "outsideLibrary" | "invalid";
  action: "optimize" | "keep";
  reason: string;
  fallback: boolean;
  presetId?: string;
  matchedRuleId?: string;
  matchedRuleName?: string;
  decision?: PolicyDecision;
}

function relativeLibraryPath(filePath: string, libraryPath: string): string | null {
  const relativePath = relative(libraryPath, filePath);
  if (!relativePath || relativePath === ".") return null;
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return null;
  return relativePath.replaceAll("\\", "/");
}

function isUnknownString(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return !normalized || normalized === "unknown" || normalized === "none" || normalized === "n/a";
}

function fieldValue(field: string, relativePath: string, probe: MediaProbe): string | number | boolean | undefined {
  switch (field) {
    case "mediaKind": return probe.mediaKind;
    case "sizeBytes": return probe.sizeBytes > 0 ? probe.sizeBytes : undefined;
    case "durationSeconds": return probe.durationSeconds > 0 ? probe.durationSeconds : undefined;
    case "videoCodec": return isUnknownString(probe.videoCodec) ? undefined : probe.videoCodec;
    case "container": return isUnknownString(probe.container) ? undefined : probe.container;
    case "width": return probe.width > 0 ? probe.width : undefined;
    case "height": return probe.height > 0 ? probe.height : undefined;
    case "bitrateKbps": return probe.bitrateKbps > 0 ? probe.bitrateKbps : undefined;
    case "bitDepth": return probe.bitDepth > 0 ? probe.bitDepth : undefined;
    case "isHdr": return probe.isHdr;
    case "audioCodec": return isUnknownString(probe.audioCodec) ? undefined : probe.audioCodec;
    case "audioChannels": return probe.audioChannels > 0 ? probe.audioChannels : undefined;
    case "subtitleCount": return probe.subtitleCount >= 0 ? probe.subtitleCount : undefined;
    case "path": return relativePath;
    default: return undefined;
  }
}

function conditionMatches(condition: Library["rules"][number]["conditions"][number], relativePath: string, probe: MediaProbe): boolean {
  const actual = fieldValue(condition.field, relativePath, probe);
  if (actual === undefined) return false;

  const expected = condition.value;
  if (condition.operator === "glob") {
    return typeof actual === "string" && typeof expected === "string"
      && picomatch(expected.replaceAll("\\", "/"), { nocase: true, dot: true })(actual);
  }

  if (typeof actual === "string") {
    const actualLower = actual.toLocaleLowerCase();
    if (condition.operator === "contains") {
      return typeof expected === "string" && actualLower.includes(expected.toLocaleLowerCase());
    }
    if (condition.operator === "oneOf") {
      return Array.isArray(expected) && expected.some((value) => typeof value === "string" && value.toLocaleLowerCase() === actualLower);
    }
    return typeof expected === "string" && actualLower === expected.toLocaleLowerCase();
  }

  if (typeof actual === "boolean") return condition.operator === "equals" && actual === expected;
  if (typeof actual !== "number") return false;
  if (condition.operator === "oneOf") return Array.isArray(expected) && (expected as number[]).includes(actual);
  if (condition.operator === "between") {
    if (!Array.isArray(expected) || expected.length !== 2) return false;
    const [lower, upper] = expected as unknown[];
    return typeof lower === "number" && typeof upper === "number" && actual >= lower && actual <= upper;
  }
  if (condition.operator === "greaterThan") return typeof expected === "number" && actual > expected;
  if (condition.operator === "lessThan") return typeof expected === "number" && actual < expected;
  return typeof expected === "number" && actual === expected;
}

function findPreset(presets: readonly Preset[], id: string): Preset | undefined {
  return presets.find((preset) => preset.id === id);
}

function emptyDecision(reason: string): PolicyDecision {
  return { shouldTranscode: false, reason, recommendedAction: "Keep", estimatedSavingsPercent: 0, estimatedSavingsBytes: 0 };
}

export function resolveFileDecision(
  filePath: string,
  probe: MediaProbe,
  library: Library,
  presets: readonly Preset[],
): RuleResolution {
  const relativePath = relativeLibraryPath(filePath, library.path);
  if (!relativePath) {
    return { status: "outsideLibrary", action: "keep", reason: "File is outside the configured library", fallback: false, decision: emptyDecision("File is outside the configured library") };
  }

  const rule = (library.rules ?? []).find((candidate) => candidate.enabled && candidate.conditions.every((condition) => conditionMatches(condition, relativePath, probe)));
  const fallback = rule === undefined;
  const selectedAction = rule?.action ?? { type: "preset" as const, presetId: library.presetId };

  if (selectedAction.type === "keep") {
    return {
      status: "ready",
      action: "keep",
      reason: rule ? `Kept by rule: ${rule.name}` : "Kept by library rule",
      fallback,
      matchedRuleId: rule?.id,
      matchedRuleName: rule?.name,
      decision: emptyDecision(rule ? `Kept by rule: ${rule.name}` : "Kept by library rule"),
    };
  }

  const preset = findPreset(presets, selectedAction.presetId);
  if (!preset) {
    const reason = `Preset ${selectedAction.presetId} is unavailable`;
    return { status: "invalid", action: "keep", reason, fallback, presetId: selectedAction.presetId, matchedRuleId: rule?.id, matchedRuleName: rule?.name, decision: emptyDecision(reason) };
  }
  if (preset.mediaKind !== probe.mediaKind) {
    const reason = `Preset ${preset.id} is for ${preset.mediaKind}, but this file is ${probe.mediaKind}`;
    return { status: "invalid", action: "keep", reason, fallback, presetId: preset.id, matchedRuleId: rule?.id, matchedRuleName: rule?.name, decision: emptyDecision(reason) };
  }

  const decision = decide(probe, preset, { mediaType: library.mediaType, minFileSizeMb: library.minFileSizeMb });
  return {
    status: "ready",
    action: decision.shouldTranscode ? "optimize" : "keep",
    reason: rule ? `${rule.name}: ${decision.reason}` : decision.reason,
    fallback,
    presetId: preset.id,
    matchedRuleId: rule?.id,
    matchedRuleName: rule?.name,
    decision,
  };
}

function resolutionLabel(resolution: string, height: number): MediaProbe["resolutionLabel"] {
  if (["4K", "1440p", "1080p", "720p", "480p", "SD"].includes(resolution)) return resolution as MediaProbe["resolutionLabel"];
  if (height >= 2000) return "4K";
  if (height >= 1300) return "1440p";
  if (height >= 900) return "1080p";
  if (height >= 650) return "720p";
  if (height >= 400) return "480p";
  return "SD";
}

export function fileRecordToProbe(file: FileRecord, metadata: PolicyMetadata): MediaProbe {
  return {
    mediaKind: metadata.mediaKind,
    durationSeconds: file.durationSeconds,
    sizeBytes: file.sizeBytes,
    videoCodec: metadata.mediaKind === "video" ? file.codec : "none",
    container: file.container,
    width: file.width,
    height: file.height,
    resolutionLabel: resolutionLabel(file.resolution, file.height),
    bitrateKbps: file.bitrateKbps,
    bitDepth: (file.bitDepth === 10 || file.bitDepth === 12 ? file.bitDepth : 8),
    isHdr: file.isHdr,
    colorTransfer: metadata.colorTransfer ?? undefined,
    fps: metadata.fps,
    audioCodec: file.audioCodec,
    audioChannels: file.audioChannels,
    subtitleCount: file.subtitleCount,
    isLosslessAudio: metadata.isLosslessAudio,
    audioTracks: metadata.audioTracks,
    subtitleTracks: metadata.subtitleTracks,
    originalLanguage: metadata.originalLanguage,
  };
}

export function resolveIndexedFileDecision(file: FileRecord, library: Library, presets: readonly Preset[]): RuleResolution {
  if (!file.policyMetadata) {
    return { status: "needsScan", action: "keep", reason: "A library scan is required to refresh file metadata", fallback: false, decision: emptyDecision("A library scan is required to refresh file metadata") };
  }
  return resolveFileDecision(file.path, fileRecordToProbe(file, file.policyMetadata), library, presets);
}
