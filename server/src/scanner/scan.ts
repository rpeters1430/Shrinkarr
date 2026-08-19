import type { Library, Preset } from "../config/schema.js";
import type { FilesRepo } from "../db/filesRepo.js";
import type { JobsRepo } from "../db/jobsRepo.js";
import { probeFile } from "../media/ffprobe.js";
import { walkLibrary } from "./walk.js";
import { decide } from "./policy.js";

export interface ScanResultEntry {
  path: string;
  codec: string;
  shouldTranscode: boolean;
  reason: string;
}

export interface ScanResult {
  entries: ScanResultEntry[];
  queuedCount: number;
}

export async function scanLibrary(
  library: Library,
  preset: Preset,
  filesRepo: FilesRepo,
  jobsRepo: JobsRepo,
): Promise<ScanResult> {
  const paths = await walkLibrary(library.path);
  const entries: ScanResultEntry[] = [];
  let queuedCount = 0;

  for (const path of paths) {
    const probe = await probeFile(path);
    const decision = decide(probe, preset);

    filesRepo.upsertFile({
      path,
      libraryId: library.id,
      codec: probe.videoCodec,
      container: probe.container,
      sizeBytes: probe.sizeBytes,
      durationSeconds: probe.durationSeconds,
      needsTranscode: decision.shouldTranscode,
      skipReason: decision.shouldTranscode ? null : decision.reason,
    });

    if (decision.shouldTranscode && !jobsRepo.hasActiveJobForPath(path)) {
      jobsRepo.enqueueJob(path, preset.id, probe.sizeBytes);
      queuedCount += 1;
    }

    entries.push({
      path,
      codec: probe.videoCodec,
      shouldTranscode: decision.shouldTranscode,
      reason: decision.reason,
    });
  }

  return { entries, queuedCount };
}
