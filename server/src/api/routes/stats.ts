import type { FastifyInstance } from "fastify";

export async function statsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/stats", async () => {
    const { jobsRepo, config } = fastify.ctx;

    const allJobs = jobsRepo.listJobs();
    const jobsByStatus: Record<string, number> = {};
    for (const job of allJobs) {
      jobsByStatus[job.status] = (jobsByStatus[job.status] ?? 0) + 1;
    }

    const doneJobs = allJobs.filter((j) => j.status === "done");
    const originalBytes = doneJobs.reduce((sum, j) => sum + (j.originalSizeBytes ?? 0), 0);
    const newBytes = doneJobs.reduce((sum, j) => sum + (j.newSizeBytes ?? 0), 0);

    let filesScanned = 0;
    for (const library of config.libraries) {
      filesScanned += fastify.ctx.filesRepo.getFilesByLibrary(library.id).length;
    }

    return {
      filesScanned,
      jobsByStatus,
      spaceSavedBytes: Math.max(0, originalBytes - newBytes),
      transcodedCount: doneJobs.length,
    };
  });
}
