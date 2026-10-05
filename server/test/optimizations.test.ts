import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/client.js";
import { FilesRepo } from "../src/db/filesRepo.js";
import { JobsRepo } from "../src/db/jobsRepo.js";
import { checkMediaServerStreaming } from "../src/queue/processor.js";
import type { WorkerDeps } from "../src/queue/worker.js";
import { getDiskSpaceInfo, getFreeDiskSpaceBytes, getTotalDiskSpaceBytes } from "../src/utils/diskSpace.js";
import { sampledHash } from "../src/duplicates/finder.js";

describe("Application Optimizations", () => {
  describe("Disk space consolidated probing", () => {
    it("returns freeBytes and totalBytes in a single call", async () => {
      const dir = mkdtempSync(join(tmpdir(), "shrinkarr-disk-opt-"));
      try {
        const info = await getDiskSpaceInfo(dir);
        expect(typeof info.freeBytes).toBe("number");
        expect(typeof info.totalBytes).toBe("number");
        expect(info.freeBytes).toBeGreaterThanOrEqual(0);
        expect(info.totalBytes).toBeGreaterThanOrEqual(0);

        const free = await getFreeDiskSpaceBytes(dir);
        const total = await getTotalDiskSpaceBytes(dir);
        expect(free).toBeGreaterThanOrEqual(0);
        expect(total).toBeGreaterThanOrEqual(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("gracefully falls back on nonexistent path", async () => {
      const info = await getDiskSpaceInfo("Z:\\nonexistent\\shrinkarr\\test\\path");
      expect(info.freeBytes).toBe(Infinity);
      expect(info.totalBytes).toBe(0);
    });
  });

  describe("pruneMissingFiles knownExistingPaths optimization", () => {
    it("prunes deleted files accurately when knownExistingPaths is supplied without DB lookup", () => {
      const dir = mkdtempSync(join(tmpdir(), "shrinkarr-db-opt-"));
      const db = openDb(join(dir, "test.db"));
      try {
        const repo = new FilesRepo(db);
        repo.upsertFile({
          path: "/media/movie1.mkv",
          libraryId: "movies",
          sizeBytes: 1000,
          durationSeconds: 100,
          resolution: "1080p",
          width: 1920,
          height: 1080,
          codec: "h264",
          container: "mkv",
          bitrateKbps: 5000,
          bitDepth: 8,
          isHdr: false,
          audioCodec: "aac",
          audioChannels: 2,
          subtitleCount: 0,
          mtimeMs: 123456,
          needsTranscode: false,
          recommendedAction: "Keep",
          estimatedSavingsBytes: 0,
        });
        repo.upsertFile({
          path: "/media/movie2.mkv",
          libraryId: "movies",
          sizeBytes: 2000,
          durationSeconds: 100,
          resolution: "1080p",
          width: 1920,
          height: 1080,
          codec: "h264",
          container: "mkv",
          bitrateKbps: 5000,
          bitDepth: 8,
          isHdr: false,
          audioCodec: "aac",
          audioChannels: 2,
          subtitleCount: 0,
          mtimeMs: 123456,
          needsTranscode: false,
          recommendedAction: "Keep",
          estimatedSavingsBytes: 0,
        });

        // Only movie1 is still on disk
        const diskPaths = new Set(["/media/movie1.mkv"]);
        const knownPaths = ["/media/movie1.mkv", "/media/movie2.mkv"];

        const pruned = repo.pruneMissingFiles("movies", diskPaths, knownPaths);
        expect(pruned).toBe(1);
        expect(repo.getFileByPath("/media/movie1.mkv")).toBeDefined();
        expect(repo.getFileByPath("/media/movie2.mkv")).toBeUndefined();
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("Sampled hash buffer performance", () => {
    it("hashes files correctly with allocUnsafe buffer", async () => {
      const dir = mkdtempSync(join(tmpdir(), "shrinkarr-hash-opt-"));
      const testFile = join(dir, "test.bin");
      try {
        const payload = Buffer.from("Shrinkarr optimization test payload data for hashing verification");
        writeFileSync(testFile, payload);
        const hash1 = await sampledHash(testFile, payload.length);
        const hash2 = await sampledHash(testFile, payload.length);
        expect(hash1).toBe(hash2);
        expect(hash1).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("Media server streaming check cache", () => {
    it("returns false immediately when pauseOnStreaming is disabled", async () => {
      const dir = mkdtempSync(join(tmpdir(), "shrinkarr-stream-opt-"));
      const db = openDb(join(dir, "test.db"));
      try {
        const filesRepo = new FilesRepo(db);
        const jobsRepo = new JobsRepo(db);
        const deps = {
          config: {
            apiKey: "test",
            dbPath: join(dir, "test.db"),
            libraries: [],
            presets: [],
            queue: { concurrency: 1, tempSuffix: ".temp", pauseOnStreaming: false },
          },
          filesRepo,
          jobsRepo,
        };

        const result = await checkMediaServerStreaming(deps as unknown as WorkerDeps);
        expect(result).toBe(false);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("caches streaming status for short durations when pauseOnStreaming is enabled", async () => {
      const dir = mkdtempSync(join(tmpdir(), "shrinkarr-stream-opt2-"));
      const db = openDb(join(dir, "test.db"));
      try {
        const filesRepo = new FilesRepo(db);
        const jobsRepo = new JobsRepo(db);
        let callCount = 0;
        const fakeFetch = vi.fn().mockImplementation(async () => {
          callCount++;
          return {
            ok: true,
            status: 200,
            json: async () => [{ NowPlayingItem: { Name: "Movie" }, PlayState: { IsPaused: false } }],
          };
        });
        vi.stubGlobal("fetch", fakeFetch);

        const deps = {
          config: {
            apiKey: "test",
            dbPath: join(dir, "test.db"),
            libraries: [],
            presets: [],
            queue: { concurrency: 1, tempSuffix: ".temp", pauseOnStreaming: true },
            integrations: {
              jellyfin: {
                url: "http://127.0.0.1:8096",
                apiKey: "jf-key",
              },
            },
          },
          filesRepo,
          jobsRepo,
        };

        // First call fetches from remote
        const r1 = await checkMediaServerStreaming(deps as unknown as WorkerDeps, true);
        expect(r1).toBe(true);
        const initialCount = callCount;

        // Second call within cache window returns cached result without refetching
        const r2 = await checkMediaServerStreaming(deps as unknown as WorkerDeps);
        expect(r2).toBe(true);
        expect(callCount).toBe(initialCount);

        vi.unstubAllGlobals();
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
