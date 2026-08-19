import { getConfig } from "../config/index.js";
import { openDb } from "../db/client.js";
import { FilesRepo } from "../db/filesRepo.js";
import { JobsRepo } from "../db/jobsRepo.js";
import { scanLibrary } from "../scanner/scan.js";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

export async function runScan(): Promise<void> {
  const config = getConfig();
  const db = openDb(config.dbPath);
  const filesRepo = new FilesRepo(db);
  const jobsRepo = new JobsRepo(db);

  const presetsById = new Map(config.presets.map((preset) => [preset.id, preset]));

  let totalFiles = 0;
  let totalRecommended = 0;
  let totalPotentialSavings = 0;

  for (const library of config.libraries) {
    const preset = presetsById.get(library.presetId) ?? config.presets[0];
    if (!preset) {
      console.error(`Library "${library.id}" references unknown preset "${library.presetId}", skipping.`);
      continue;
    }

    console.log(`\nScanning library "${library.name}" (${library.path})...`);
    const result = await scanLibrary(library, preset, filesRepo, jobsRepo);

    console.table(
      result.entries.map((entry) => ({
        file: entry.path.split(/[/\\]/).pop(),
        codec: entry.codec,
        res: entry.resolution,
        size: formatBytes(entry.sizeBytes),
        action: entry.recommendedAction,
        savings: formatBytes(entry.estimatedSavingsBytes),
        status: entry.shouldTranscode ? "Recommended" : "Keep",
      })),
    );

    totalFiles += result.totalScanned;
    totalRecommended += result.recommendedCount;
    totalPotentialSavings += result.totalPotentialSavingsBytes;
  }

  console.log(
    `\nScan complete: ${totalFiles} files scanned. ${totalRecommended} files recommended for optimization (Potential savings: ${formatBytes(totalPotentialSavings)}).`,
  );
  db.close();
}
