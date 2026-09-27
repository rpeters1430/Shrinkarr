import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { findDuplicates, type DuplicateOptions } from "../../duplicates/finder.js";
import { disposeBackup } from "../../queue/atomicReplace.js";
import { isPathInsideLibraries } from "../../scanner/pathGuard.js";

interface DeleteItem {
  path: string;
  keepPath: string;
}

export async function duplicateRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: DuplicateOptions }>("/api/duplicates/find", async (request, reply) => {
    const body = request.body || {};
    if (body.hashMode !== undefined && body.hashMode !== "sampled" && body.hashMode !== "full") {
      return reply.code(400).send({ error: `Invalid hashMode "${String(body.hashMode)}"` });
    }
    if (body.findIdentical === false && body.findSameTitle === false) {
      return reply.code(400).send({ error: "Pick at least one kind of duplicate to look for" });
    }
    const { config, filesRepo } = fastify.ctx;
    return findDuplicates(filesRepo.getAllFiles(), config.libraries, {
      libraryIds: Array.isArray(body.libraryIds) ? body.libraryIds.filter((id) => typeof id === "string") : undefined,
      findIdentical: body.findIdentical,
      findSameTitle: body.findSameTitle,
      durationToleranceSeconds: typeof body.durationToleranceSeconds === "number" ? body.durationToleranceSeconds : undefined,
      minSizeMb: typeof body.minSizeMb === "number" ? body.minSizeMb : undefined,
      acrossLibraries: body.acrossLibraries,
      hashMode: body.hashMode,
    });
  });

  // Every removal names the copy being kept, and is refused unless that copy
  // is still on disk, so a stale or tampered request can't delete every copy.
  fastify.post<{ Body: { items?: DeleteItem[] } }>("/api/duplicates/delete", async (request, reply) => {
    const items = request.body?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return reply.code(400).send({ error: "items must be a non-empty array of { path, keepPath }" });
    }
    const { config, filesRepo, jobsRepo } = fastify.ctx;
    const removing = new Set(items.map((item) => (typeof item?.path === "string" ? resolve(item.path) : "")));
    const deleted: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    let freedBytes = 0;

    for (const item of items) {
      const path = typeof item?.path === "string" ? item.path : "";
      const keepPath = typeof item?.keepPath === "string" ? item.keepPath : "";
      const fail = (error: string) => failed.push({ path, error });

      if (!path || !keepPath) { fail("path and keepPath are required"); continue; }
      if (resolve(path) === resolve(keepPath)) { fail("A file can't be kept and deleted at once"); continue; }
      if (removing.has(resolve(keepPath))) { fail("The file to keep is also marked for deletion"); continue; }
      if (!isPathInsideLibraries(path, config.libraries) || !isPathInsideLibraries(keepPath, config.libraries)) {
        fail("Both files must be inside a configured library"); continue;
      }
      if (!filesRepo.getFileByPath(path)) { fail("Not a scanned library file"); continue; }
      if (!existsSync(keepPath)) { fail("The file to keep is no longer on disk"); continue; }
      if (jobsRepo.hasActiveJobForPath(path) || jobsRepo.hasActiveJobForPath(keepPath)) {
        fail("A transcode job is queued or running for one of these files"); continue;
      }

      try {
        const size = existsSync(path) ? statSync(path).size : 0;
        if (existsSync(path)) {
          await disposeBackup(path, path, config.queue.recycleBinPath);
        }
        if (existsSync(path)) { fail("Could not remove the file"); continue; }
        filesRepo.deleteFileByPath(path);
        deleted.push(path);
        freedBytes += size;
      } catch (err) {
        fail((err as Error).message);
      }
    }

    return { deleted, failed, freedBytes, recycled: Boolean(config.queue.recycleBinPath) };
  });
}
