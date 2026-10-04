import type { FastifyInstance } from "fastify";
import { getDiskSpaceInfo } from "../../utils/diskSpace.js";

export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/stats", async () => {
    const { jobsRepo, filesRepo, config } = fastify.ctx;
    const fileStats = filesRepo.getAggregatedStats(config.libraries);
    const jobStats = jobsRepo.getJobStats();

    const librarySummariesWithDisk = await Promise.all(
      fileStats.librarySummaries.map(async (lib) => {
        let freeBytes: number | null = null;
        let totalDiskBytes: number | null = null;
        if (lib.path) {
          try {
            const diskInfo = await getDiskSpaceInfo(lib.path);
            if (diskInfo.freeBytes !== Infinity && diskInfo.freeBytes >= 0) freeBytes = diskInfo.freeBytes;
            if (diskInfo.totalBytes > 0) totalDiskBytes = diskInfo.totalBytes;
          } catch {
            // ignore disk query errors
          }
        }
        return {
          ...lib,
          freeBytes,
          totalDiskBytes,
        };
      }),
    );

    return {
      filesScanned: fileStats.filesScanned,
      totalLibrarySizeBytes: fileStats.totalLibrarySizeBytes,
      totalPotentialSavingsBytes: fileStats.totalPotentialSavingsBytes,
      recommendedCount: fileStats.recommendedCount,
      spaceSavedBytes: jobStats.spaceSavedBytes,
      transcodedCount: jobStats.transcodedCount,
      jobsByStatus: jobStats.jobsByStatus,
      codecBreakdown: fileStats.codecBreakdown,
      resolutionBreakdown: fileStats.resolutionBreakdown,
      librarySummaries: librarySummariesWithDisk,
    };
  });
}
