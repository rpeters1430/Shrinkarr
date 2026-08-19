import type { FastifyInstance } from "fastify";

export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/stats", async () => {
    const { jobsRepo, filesRepo, config } = fastify.ctx;

    const allJobs = jobsRepo.listJobs();
    const jobsByStatus: Record<string, number> = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const job of allJobs) {
      jobsByStatus[job.status] = (jobsByStatus[job.status] ?? 0) + 1;
    }

    const doneJobs = allJobs.filter((j) => j.status === "done");
    const originalBytes = doneJobs.reduce((sum, j) => sum + (j.originalSizeBytes ?? 0), 0);
    const newBytes = doneJobs.reduce((sum, j) => sum + (j.newSizeBytes ?? 0), 0);

    const allFiles = filesRepo.getAllFiles();
    let totalLibrarySizeBytes = 0;
    let totalPotentialSavingsBytes = 0;
    let recommendedCount = 0;

    const codecBreakdown: Record<string, { count: number; sizeBytes: number }> = {};
    const resolutionBreakdown: Record<string, { count: number; sizeBytes: number }> = {};

    for (const file of allFiles) {
      totalLibrarySizeBytes += file.sizeBytes;
      if (file.needsTranscode) {
        recommendedCount += 1;
        totalPotentialSavingsBytes += file.estimatedSavingsBytes;
      }

      const codecKey = (file.codec || "unknown").toUpperCase();
      if (!codecBreakdown[codecKey]) {
        codecBreakdown[codecKey] = { count: 0, sizeBytes: 0 };
      }
      codecBreakdown[codecKey].count += 1;
      codecBreakdown[codecKey].sizeBytes += file.sizeBytes;

      const resKey = file.resolution || "1080p";
      if (!resolutionBreakdown[resKey]) {
        resolutionBreakdown[resKey] = { count: 0, sizeBytes: 0 };
      }
      resolutionBreakdown[resKey].count += 1;
      resolutionBreakdown[resKey].sizeBytes += file.sizeBytes;
    }

    const librarySummaries = config.libraries.map((lib) => {
      const libFiles = filesRepo.getFilesByLibrary(lib.id);
      const totalSize = libFiles.reduce((acc, f) => acc + f.sizeBytes, 0);
      const potentialSavings = libFiles.reduce((acc, f) => acc + (f.needsTranscode ? f.estimatedSavingsBytes : 0), 0);
      const eligibleFiles = libFiles.filter((f) => f.needsTranscode).length;

      return {
        id: lib.id,
        name: lib.name,
        path: lib.path,
        mediaType: lib.mediaType,
        presetId: lib.presetId,
        fileCount: libFiles.length,
        totalSizeBytes: totalSize,
        potentialSavingsBytes: potentialSavings,
        eligibleCount: eligibleFiles,
      };
    });

    return {
      filesScanned: allFiles.length,
      totalLibrarySizeBytes,
      totalPotentialSavingsBytes,
      recommendedCount,
      spaceSavedBytes: Math.max(0, originalBytes - newBytes),
      transcodedCount: doneJobs.length,
      jobsByStatus,
      codecBreakdown,
      resolutionBreakdown,
      librarySummaries,
    };
  });
}
