import type { Config } from "../config/schema.js";
import type { FilesRepo } from "../db/filesRepo.js";
import type { JobsRepo } from "../db/jobsRepo.js";
import type { LibraryWatcher } from "../scanner/watcher.js";
import type { ProcessorHandle } from "../queue/processor.js";

export interface AppContext {
  config: Config;
  configPath: string;
  filesRepo: FilesRepo;
  jobsRepo: JobsRepo;
  watcher?: LibraryWatcher;
  processor?: ProcessorHandle;
}

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
