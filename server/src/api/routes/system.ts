import { readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import os from "node:os";
import type { FastifyInstance } from "fastify";

export interface DriveInfo {
  name: string;
  path: string;
  isNasOrNetwork?: boolean;
}

export function detectAvailableDrives(): DriveInfo[] {
  const drives: DriveInfo[] = [];
  const platform = os.platform();

  if (platform === "win32") {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    for (const letter of letters) {
      const drivePath = `${letter}:\\`;
      try {
        if (existsSync(drivePath)) {
          const isZ = letter === "Z";
          drives.push({
            name: `${letter}: ${letter === "C" ? "(Local OS)" : isZ ? "(NAS Share)" : "(Drive)"}`,
            path: drivePath,
            isNasOrNetwork: isZ,
          });
        }
      } catch {
        // Skip inaccessible drives
      }
    }
  } else {
    // Linux / macOS mounts
    const commonMounts = ["/", "/media", "/mnt", "/nas", "/storage", "/shares"];
    for (const mount of commonMounts) {
      if (existsSync(mount)) {
        drives.push({
          name: mount === "/" ? "Root (/)" : mount,
          path: mount,
        });
      }
    }
  }

  return drives;
}

export function findSuggestedMediaFolders(): string[] {
  const suggestions: string[] = [];
  const drives = detectAvailableDrives();

  const commonNames = [
    "Movies",
    "TV Shows",
    "TV",
    "movies",
    "tv",
    "Media",
    "media",
    "Anime",
    "anime",
    "Videos",
    "downloads",
    "movie-radarr",
    "movies-radarr",
    "tv-sonarr",
  ];

  for (const drive of drives) {
    for (const name of commonNames) {
      const candidate = join(drive.path, name);
      try {
        if (existsSync(candidate) && statSync(candidate).isDirectory()) {
          suggestions.push(resolve(candidate));
        }
      } catch {
        // ignore
      }
    }
  }

  return Array.from(new Set(suggestions));
}

export async function systemRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Querystring: { path?: string } }>("/api/system/browse", async (request, reply) => {
    const availableDrives = detectAvailableDrives();
    const suggestedMediaFolders = findSuggestedMediaFolders();

    let targetPath = request.query.path;

    // If no path provided, prefer NAS drive if it exists, otherwise first drive
    if (!targetPath || !existsSync(targetPath)) {
      const nasDrive = availableDrives.find((d) => d.isNasOrNetwork);
      targetPath = nasDrive ? nasDrive.path : (availableDrives[0]?.path ?? (os.platform() === "win32" ? "C:\\" : "/"));
    }

    try {
      const entries = readdirSync(targetPath, { withFileTypes: true });
      const dirs: { name: string; path: string }[] = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          // Skip hidden / system / temp folders
          if (
            entry.name.startsWith(".") ||
            entry.name.startsWith("$") ||
            entry.name === "#recycle" ||
            entry.name === "System Volume Information"
          ) {
            continue;
          }
          dirs.push({
            name: entry.name,
            path: join(targetPath, entry.name),
          });
        }
      }

      return {
        currentPath: resolve(targetPath),
        parentPath: dirname(resolve(targetPath)),
        directories: dirs.sort((a, b) => a.name.localeCompare(b.name)),
        availableDrives,
        suggestedMediaFolders,
      };
    } catch (err) {
      return reply.code(400).send({
        error: `Cannot read path "${targetPath}": ${(err as Error).message}`,
        availableDrives,
        suggestedMediaFolders,
      });
    }
  });

  fastify.get("/api/system/drives", async () => {
    return {
      drives: detectAvailableDrives(),
      suggestedMediaFolders: findSuggestedMediaFolders(),
    };
  });

  fastify.post("/api/system/optimize-all", async () => {
    const { config, filesRepo, jobsRepo } = fastify.ctx;
    const eligible = filesRepo.getEligibleFiles();
    let queued = 0;

    for (const file of eligible) {
      if (!jobsRepo.hasActiveJobForPath(file.path)) {
        const lib = config.libraries.find((l) => l.id === file.libraryId);
        const presetId = lib?.presetId || config.presets[0]?.id || "balanced";
        jobsRepo.enqueueJob(file.path, presetId, file.sizeBytes);
        queued += 1;
      }
    }

    return { queued, totalEligible: eligible.length };
  });
}
