import { getConfig } from "../config/index.js";
import { openDb } from "../db/client.js";
import { FilesRepo } from "../db/filesRepo.js";
import { JobsRepo } from "../db/jobsRepo.js";
import { scanLibrary } from "../scanner/scan.js";

export async function runScan(): Promise<void> {
  const config = getConfig();
  const db = openDb(config.dbPath);
  const filesRepo = new FilesRepo(db);
  const jobsRepo = new JobsRepo(db);

  const presetsById = new Map(config.presets.map((preset) => [preset.id, preset]));

  let totalFiles = 0;
  let totalQueued = 0;

  for (const library of config.libraries) {
    const preset = presetsById.get(library.presetId);
    if (!preset) {
      console.error(`Library "${library.id}" references unknown preset "${library.presetId}", skipping.`);
      continue;
    }

    console.log(`\nScanning library "${library.name}" (${library.path})...`);
    const result = await scanLibrary(library, preset, filesRepo, jobsRepo);

    console.table(
      result.entries.map((entry) => ({
        path: entry.path,
        codec: entry.codec,
        decision: entry.shouldTranscode ? "transcode" : "skip",
        reason: entry.reason,
      })),
    );

    totalFiles += result.entries.length;
    totalQueued += result.queuedCount;
  }

  console.log(`\n${totalFiles} files scanned, ${totalQueued} queued for transcode.`);
  db.close();
}
