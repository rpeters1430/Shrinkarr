import type { Library, Preset } from "../config/schema.js";
import type { FilesRepo } from "../db/filesRepo.js";
import { encodeFingerprint } from "../scanner/policy.js";
import { resolveIndexedFileDecision } from "../scanner/rules.js";

/**
 * Records that encoding this file with the preset made it larger, and
 * re-runs its scan verdict so scans and the watcher stop queueing the same
 * encode. The verdict becomes Keep, or Remux when its tracks still need work.
 */
export function recordNoGainEncode(
  filesRepo: FilesRepo,
  filePath: string,
  preset: Preset,
  library: Library | undefined,
  presets: Preset[],
): void {
  const file = filesRepo.getFileByPath(filePath);
  if (!file?.policyMetadata) return;
  const fingerprint = encodeFingerprint(preset);
  const noGainEncodes = [...new Set([...(file.policyMetadata.noGainEncodes ?? []), fingerprint])];
  const updated = { ...file, policyMetadata: { ...file.policyMetadata, noGainEncodes } };
  filesRepo.upsertFile(updated);
  const resolved = library ? resolveIndexedFileDecision(updated, library, presets) : undefined;
  const decision = resolved?.decision;
  filesRepo.updateRecommendation(filePath, {
    needsTranscode: decision?.shouldTranscode ?? false,
    recommendedAction: decision?.recommendedAction ?? "Keep",
    estimatedSavingsBytes: decision?.estimatedSavingsBytes ?? 0,
    reason: resolved?.reason ?? "re-encoding with this preset made the file larger, so the video is kept",
  });
}
