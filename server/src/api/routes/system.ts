import { readdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import os from "node:os";
import type { FastifyInstance } from "fastify";

export interface DriveInfo {
  name: string;
  path: string;
  isNasOrNetwork?: boolean;
}

function isSystemPath(p: string): boolean {
  const ignoredPrefixes = [
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/var",
    "/etc",
    "/root",
    "/boot",
    "/tmp",
    "/srv",
    "/home",
    "/app",
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/opt",
  ];
  return ignoredPrefixes.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
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
    const seenPaths = new Set<string>();

    function addDrive(drivePath: string, name?: string, isNas?: boolean) {
      try {
        const resolved = resolve(drivePath);
        if (!existsSync(resolved) || seenPaths.has(resolved)) return;
        seenPaths.add(resolved);
        drives.push({
          name: name || (resolved === "/" ? "Root (/)" : resolved),
          path: resolved,
          isNasOrNetwork: Boolean(isNas),
        });
      } catch {
        // Ignore inaccessible paths
      }
    }

    // Always include root
    addDrive("/", "Root (/)");

    // 1. Try parsing /proc/mounts to detect mounted shares (Docker volume mounts, CIFS, NFS, bind mounts)
    if (existsSync("/proc/mounts")) {
      try {
        const mountsContent = readFileSync("/proc/mounts", "utf8");
        const lines = mountsContent.split("\n");
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3) {
            const [spec, rawMountPath, fstype] = parts;
            const mountPath = rawMountPath.replace(/\\040/g, " ");

            const isNetwork =
              ["cifs", "smbfs", "smb3", "nfs", "nfs3", "nfs4", "fuse.sshfs", "fuse.rclone", "davfs"].includes(
                fstype
              ) ||
              spec.startsWith("//") ||
              spec.startsWith("\\\\") ||
              spec.includes(":/");

            // Include network mounts, and non-system custom mounts (e.g. /volume1/Media, /mnt/nas)
            if (isNetwork || (!isSystemPath(mountPath) && mountPath !== "/")) {
              const label = isNetwork ? `${mountPath} (NAS Share)` : mountPath;
              addDrive(mountPath, label, isNetwork);
            }
          }
        }
      } catch {
        // Ignore errors reading /proc/mounts
      }
    }

    // 2. Common root/mount directories to check
    const commonRoots = [
      "/volume1",
      "/volume2",
      "/volume3",
      "/volume4",
      "/media",
      "/mnt",
      "/nas",
      "/storage",
      "/shares",
      "/data",
    ];

    for (const root of commonRoots) {
      if (existsSync(root)) {
        addDrive(root, root);
        try {
          const entries = readdirSync(root, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith(".")) {
              const subPath = join(root, entry.name);
              addDrive(subPath, subPath);
            }
          }
        } catch {
          // Ignore unreadable dirs
        }
      }
    }

    // Sort NAS / Network drives first, then Root, then alphabetical
    drives.sort((a, b) => {
      if (a.isNasOrNetwork && !b.isNasOrNetwork) return -1;
      if (!a.isNasOrNetwork && b.isNasOrNetwork) return 1;
      if (a.path === "/") return -1;
      if (b.path === "/") return 1;
      return a.path.localeCompare(b.path);
    });
  }

  return drives;
}

export function findSuggestedMediaFolders(): string[] {
  const suggestions: string[] = [];
  const seen = new Set<string>();

  const userVideos = join(os.homedir(), "Videos");
  if (existsSync(userVideos)) {
    suggestions.push(userVideos);
    seen.add(userVideos.toLowerCase());
  }

  const drives = detectAvailableDrives();

  const commonNames = [
    "movies",
    "tv",
    "tv shows",
    "media",
    "anime",
    "videos",
    "youtube",
    "downloads",
    "movie-radarr",
    "movies-radarr",
    "tv-sonarr",
  ];

  for (const drive of drives) {
    const driveBase = basename(drive.path).toLowerCase();
    if (commonNames.includes(driveBase) && drive.path !== "/" && drive.path !== "C:\\") {
      if (!seen.has(drive.path.toLowerCase())) {
        suggestions.push(drive.path);
        seen.add(drive.path.toLowerCase());
      }
    }

    try {
      const entries = readdirSync(drive.path, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "#recycle") {
          const fullPath = join(drive.path, entry.name);
          if (commonNames.includes(entry.name.toLowerCase()) && !seen.has(fullPath.toLowerCase())) {
            suggestions.push(fullPath);
            seen.add(fullPath.toLowerCase());
          }
          // If the entry is a container folder like 'Media' or 'nas', search 1 level deeper
          if (
            ["media", "downloads", "data", "storage", "nas", "share", "shares"].includes(
              entry.name.toLowerCase()
            ) ||
            drive.isNasOrNetwork
          ) {
            try {
              const subEntries = readdirSync(fullPath, { withFileTypes: true });
              for (const sub of subEntries) {
                if (sub.isDirectory() && !sub.name.startsWith(".") && sub.name !== "#recycle") {
                  if (commonNames.includes(sub.name.toLowerCase())) {
                    suggestions.push(join(fullPath, sub.name));
                  }
                }
              }
            } catch {
              // Ignore unreadable dirs
            }
          }
        }
      }
    } catch {
      // Ignore unreadable dirs
    }
  }

  return Array.from(new Set(suggestions)).filter((p) => p !== "/" && p !== "C:\\");
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
