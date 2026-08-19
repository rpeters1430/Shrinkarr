import type { Config } from "../config/schema.js";
import type { FilesRepo } from "../db/filesRepo.js";
import type { JobsRepo } from "../db/jobsRepo.js";

export interface AppContext {
  config: Config;
  configPath: string;
  filesRepo: FilesRepo;
  jobsRepo: JobsRepo;
}

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
