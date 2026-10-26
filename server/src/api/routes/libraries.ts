import type { FastifyInstance } from "fastify";
import { relative } from "node:path";
import { z } from "zod";
import { scanCoordinator } from "../../scanner/coordinator.js";
import { getScanProgress } from "../../scanner/tracker.js";
import { applyConfig } from "../applyConfig.js";
import { ConfigSchema, LibraryRuleSchema, LibrarySchema, type Library, type Preset } from "../../config/schema.js";
import type { FileRecord } from "../../db/filesRepo.js";
import { resolveIndexedFileDecision } from "../../scanner/rules.js";
import { isPathInsideLibraries } from "../../scanner/pathGuard.js";
import { lookupOriginalLanguage } from "../../integrations/originalLanguage.js";

const RULE_PREVIEW_PAGE_SIZE = 50;
const RULE_PREVIEW_MAX_PAGE_SIZE = 200;
const RulePreviewBodySchema = z.object({
  rules: z.array(LibraryRuleSchema).default([]),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(RULE_PREVIEW_MAX_PAGE_SIZE).default(RULE_PREVIEW_PAGE_SIZE),
});
const RuleQueueBodySchema = z.object({
  filePaths: z.array(z.string().min(1)).min(1).max(RULE_PREVIEW_MAX_PAGE_SIZE),
});

function relativeInsideLibrary(filePath: string, library: Library): string | null {
  if (!isPathInsideLibraries(filePath, [library])) return null;
  const path = relative(library.path, filePath).replaceAll("\\", "/");
  return path && path !== "." && !path.startsWith("../") ? path : null;
}

function previewFile(file: FileRecord, library: Library, presets: Preset[]) {
  const relativePath = relativeInsideLibrary(file.path, library);
  if (!relativePath) {
    return { filePath: null, status: "outsideLibrary", action: "keep", fallback: false, reason: "File is outside the configured library", estimatedSavingsBytes: 0 };
  }
  const decision = resolveIndexedFileDecision(file, library, presets);
  return {
    filePath: file.path,
    relativePath,
    status: decision.status,
    action: decision.action,
    presetId: decision.presetId ?? null,
    matchedRuleId: decision.matchedRuleId ?? null,
    matchedRuleName: decision.matchedRuleName ?? null,
    fallback: decision.fallback,
    reason: decision.reason,
    estimatedSavingsBytes: decision.decision?.estimatedSavingsBytes ?? 0,
  };
}

export async function libraryRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/libraries", async () => {
    return fastify.ctx.config.libraries;
  });

  fastify.get("/api/scan/status", async () => {
    return getScanProgress();
  });

  fastify.get("/api/watcher/status", async () => {
    return fastify.ctx.watcher?.getStatus() ?? {
      enabled: false,
      isScanning: false,
      intervalMinutes: 15,
      autoOptimize: false,
      lastRunAt: null,
      nextRunAt: null,
      newFilesFoundLastRun: 0,
      autoOptimizedLastRun: 0,
      totalNewFilesDiscovered: 0,
      totalAutoOptimized: 0,
    };
  });

  fastify.post("/api/watcher/check", async () => {
    if (!fastify.ctx.watcher) {
      return { newFiles: 0, autoQueued: 0 };
    }
    return fastify.ctx.watcher.checkAllLibraries({ forceScan: false });
  });

  fastify.post("/api/libraries/scan-new", async () => {
    if (!fastify.ctx.watcher) {
      return { newFiles: 0, autoQueued: 0 };
    }
    return fastify.ctx.watcher.checkAllLibraries({ forceScan: false });
  });

  fastify.post<{ Body: unknown }>("/api/libraries", async (request, reply) => {
    const parseResult = LibrarySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.code(400).send({ error: parseResult.error.format() });
    }

    const newLib = parseResult.data;
    const existing = fastify.ctx.config.libraries.find((l) => l.id === newLib.id);
    if (existing) {
      return reply.code(409).send({ error: `Library with ID "${newLib.id}" already exists` });
    }

    const updatedLibraries = [...fastify.ctx.config.libraries, newLib];
    const newConfig = { ...fastify.ctx.config, libraries: updatedLibraries };
    const configValidation = ConfigSchema.safeParse(newConfig);
    if (!configValidation.success) return reply.code(400).send({ error: configValidation.error.format() });
    applyConfig(fastify.ctx, newConfig);

    return reply.code(201).send(newLib);
  });

  fastify.put<{ Params: { id: string }; Body: Partial<Library> }>("/api/libraries/:id", async (request, reply) => {
    const { id } = request.params;
    const index = fastify.ctx.config.libraries.findIndex((l) => l.id === id);
    if (index === -1) {
      return reply.code(404).send({ error: `Library "${id}" not found` });
    }

    const current = fastify.ctx.config.libraries[index];
    const updatedLib = { ...current, ...(request.body || {}), id };
    const parseResult = LibrarySchema.safeParse(updatedLib);
    if (!parseResult.success) {
      return reply.code(400).send({ error: parseResult.error.format() });
    }

    const updatedLibraries = [...fastify.ctx.config.libraries];
    updatedLibraries[index] = parseResult.data;
    const candidateConfig = { ...fastify.ctx.config, libraries: updatedLibraries };
    const configValidation = ConfigSchema.safeParse(candidateConfig);
    if (!configValidation.success) return reply.code(400).send({ error: configValidation.error.format() });
    const newConfig = candidateConfig;
    applyConfig(fastify.ctx, newConfig);

    return reply.send(parseResult.data);
  });

  fastify.delete<{ Params: { id: string } }>("/api/libraries/:id", async (request, reply) => {
    const { id } = request.params;
    const filtered = fastify.ctx.config.libraries.filter((l) => l.id !== id);
    if (filtered.length === fastify.ctx.config.libraries.length) {
      return reply.code(404).send({ error: `Library "${id}" not found` });
    }

    const newConfig = { ...fastify.ctx.config, libraries: filtered };
    applyConfig(fastify.ctx, newConfig);

    // Prune indexed files for this library from the database
    fastify.ctx.filesRepo.deleteFilesByLibrary(id);

    return reply.send({ success: true, id });
  });

  fastify.post<{ Body: { autoQueue?: boolean } }>("/api/libraries/scan-all", async (request, reply) => {
    const { config, filesRepo, jobsRepo } = fastify.ctx;
    if (!config.libraries || config.libraries.length === 0) {
      return reply.code(400).send({ error: "No libraries configured to scan" });
    }

    const autoQueue = Boolean(request.body?.autoQueue);
    void scanCoordinator.enqueueScanAll(config.libraries, config.presets, filesRepo, jobsRepo, {
      autoQueue,
      probeConcurrency: config.scanner?.probeConcurrency,
      collectEntries: false,
      originalLanguageOf: (path) => lookupOriginalLanguage(path, config),
    });

    return reply.code(202).send({ status: "batch scan started", totalLibraries: config.libraries.length });
  });

  fastify.post<{ Params: { id: string }; Body: { autoQueue?: boolean } }>("/api/libraries/:id/scan", async (request, reply) => {
    const { config, filesRepo, jobsRepo } = fastify.ctx;
    const library = config.libraries.find((lib) => lib.id === request.params.id);
    if (!library) {
      return reply.code(404).send({ error: `Unknown library "${request.params.id}"` });
    }
    const preset = config.presets.find((p) => p.id === library.presetId) ?? config.presets[0];
    if (!preset) {
      return reply.code(400).send({ error: `No valid preset found for library "${library.name}"` });
    }

    const autoQueue = Boolean(request.body?.autoQueue);
    void scanCoordinator.enqueueScan(library, preset, filesRepo, jobsRepo, {
      autoQueue,
      probeConcurrency: config.scanner?.probeConcurrency,
      collectEntries: false,
      presets: config.presets,
      originalLanguageOf: (path) => lookupOriginalLanguage(path, config),
    });

    return reply.code(202).send({ status: "scan started", libraryId: library.id });
  });

  fastify.post<{ Params: { id: string }; Body: unknown }>("/api/libraries/:id/rules/preview", async (request, reply) => {
    const { config, filesRepo } = fastify.ctx;
    const library = config.libraries.find((lib) => lib.id === request.params.id);
    if (!library) return reply.code(404).send({ error: `Unknown library "${request.params.id}"` });

    const bodyResult = RulePreviewBodySchema.safeParse(request.body ?? {});
    if (!bodyResult.success) return reply.code(400).send({ error: bodyResult.error.format() });
    const updatedLibraries = config.libraries.map((item) => item.id === library.id
      ? { ...item, rules: bodyResult.data.rules }
      : item);
    const configResult = ConfigSchema.safeParse({ ...config, libraries: updatedLibraries });
    if (!configResult.success) return reply.code(400).send({ error: configResult.error.format() });
    const previewLibrary = configResult.data.libraries.find((item) => item.id === library.id)!;

    const total = filesRepo.countFilesByLibrary(library.id);
    const { offset, limit } = bodyResult.data;
    const summary = {
      total, optimize: 0, keep: 0, fallback: 0, noMatch: 0, needsScan: 0,
      ruleMatches: previewLibrary.rules.map((rule) => ({ ruleId: rule.id, ruleName: rule.name, matches: 0, optimize: 0, keep: 0 })),
    };
    const files: ReturnType<typeof previewFile>[] = [];
    const batchSize = 200;
    for (let batchOffset = 0; batchOffset < total; batchOffset += batchSize) {
      const page = filesRepo.getFilesByLibraryPage(library.id, batchOffset, batchSize);
      page.forEach((file, index) => {
        const resolved = previewFile(file, previewLibrary, configResult.data.presets);
        if (resolved.status === "needsScan") {
          summary.needsScan += 1;
        } else if (resolved.status === "ready") {
          const actionCount = resolved.action === "optimize" ? "optimize" : "keep";
          summary[actionCount] += 1;
          if (resolved.matchedRuleId) {
            const ruleMatch = summary.ruleMatches.find((rule) => rule.ruleId === resolved.matchedRuleId);
            if (ruleMatch) {
              ruleMatch.matches += 1;
              ruleMatch[actionCount] += 1;
            }
          }
          if (resolved.fallback) {
            summary.fallback += 1;
            summary.noMatch += 1;
          }
        }
        const absoluteIndex = batchOffset + index;
        if (absoluteIndex >= offset && absoluteIndex < offset + limit) files.push(resolved);
      });
    }

    return reply.send({
      libraryId: library.id,
      summary,
      pagination: { offset, limit, total, hasNext: offset + files.length < total },
      files,
    });
  });

  fastify.post<{ Params: { id: string }; Body: unknown }>("/api/libraries/:id/rules/queue", async (request, reply) => {
    const { config, filesRepo, jobsRepo } = fastify.ctx;
    const library = config.libraries.find((lib) => lib.id === request.params.id);
    if (!library) return reply.code(404).send({ error: `Unknown library "${request.params.id}"` });
    const bodyResult = RuleQueueBodySchema.safeParse(request.body ?? {});
    if (!bodyResult.success) return reply.code(400).send({ error: bodyResult.error.format() });

    const filePaths = [...new Set(bodyResult.data.filePaths)];
    const selectedFiles: FileRecord[] = [];
    for (const filePath of filePaths) {
      if (!isPathInsideLibraries(filePath, [library])) {
        return reply.code(400).send({ error: "Every file path must be inside the selected library" });
      }
      const file = filesRepo.getFileByPath(filePath);
      if (!file || file.libraryId !== library.id) {
        return reply.code(400).send({ error: "Every file path must refer to an indexed file in the selected library" });
      }
      selectedFiles.push(file);
    }

    const candidates: Array<{ filePath: string; presetId: string; originalSizeBytes: number }> = [];
    const results = selectedFiles.map((file) => {
      const relativePath = relativeInsideLibrary(file.path, library);
      const baseResult = { filePath: file.path, relativePath, status: "skipped" as const };
      if (file.ignored) return { ...baseResult, reason: "File is ignored" };
      if (file.healthStatus === "corrupt") return { ...baseResult, reason: "File failed its health check" };
      if (jobsRepo.hasActiveJobForPath(file.path)) return { ...baseResult, reason: "A job is already pending or running" };

      const resolved = resolveIndexedFileDecision(file, library, config.presets);
      if (resolved.status === "needsScan") return { ...baseResult, reason: resolved.reason };
      if (resolved.status !== "ready") return { ...baseResult, reason: resolved.reason };
      if (resolved.action !== "optimize" || !resolved.decision?.shouldTranscode || !resolved.presetId) {
        return { ...baseResult, reason: resolved.reason };
      }
      const preset = config.presets.find((item) => item.id === resolved.presetId);
      if (!preset || !file.policyMetadata || preset.mediaKind !== file.policyMetadata.mediaKind) {
        return { ...baseResult, reason: "The selected preset is unavailable or incompatible" };
      }
      candidates.push({ filePath: file.path, presetId: preset.id, originalSizeBytes: file.sizeBytes });
      return { filePath: file.path, relativePath, status: "queued" as const, reason: resolved.reason, presetId: preset.id };
    });

    const created = jobsRepo.enqueueJobsBatch(candidates);
    const createdPaths = new Set(created.map((job) => job.filePath));
    const finalizedResults = results.map((result) => result.status === "queued" && !createdPaths.has(result.filePath)
      ? { ...result, status: "skipped" as const, reason: "A job was created for this file before it could be queued" }
      : result);
    return reply.send({ libraryId: library.id, queued: created.length, results: finalizedResults });
  });

  fastify.post<{ Params: { id: string } }>("/api/libraries/:id/optimize", async (request, reply) => {
    const { config, filesRepo, jobsRepo } = fastify.ctx;
    const library = config.libraries.find((lib) => lib.id === request.params.id);
    if (!library) {
      return reply.code(404).send({ error: `Unknown library "${request.params.id}"` });
    }
    const preset = config.presets.find((p) => p.id === library.presetId) ?? config.presets[0];
    if (!preset) {
      return reply.code(400).send({ error: `No valid preset found for library "${library.name}"` });
    }

    const eligible = filesRepo.getEligibleFiles(library.id);
    const toQueue = (library.rules?.length ?? 0) === 0
      ? eligible.map((file) => ({ filePath: file.path, presetId: preset.id, originalSizeBytes: file.sizeBytes }))
      : filesRepo.getFilesByLibrary(library.id).flatMap((file) => {
        if (file.ignored || file.healthStatus === "corrupt") return [];
        const resolved = resolveIndexedFileDecision(file, library, config.presets);
        return resolved.status === "ready" && resolved.action === "optimize" && resolved.presetId
          ? [{ filePath: file.path, presetId: resolved.presetId, originalSizeBytes: file.sizeBytes }]
          : [];
      });
    const queued = jobsRepo.enqueueJobsBatch(toQueue).length;

    return reply.send({ libraryId: library.id, queued, totalEligible: toQueue.length });
  });

  fastify.get<{ Params: { id: string } }>("/api/libraries/:id/files", async (request, reply) => {
    const { config, filesRepo } = fastify.ctx;
    const library = config.libraries.find((lib) => lib.id === request.params.id);
    if (!library) {
      return reply.code(404).send({ error: `Unknown library "${request.params.id}"` });
    }
    return filesRepo.getFilesByLibrary(library.id);
  });
}
