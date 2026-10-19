import type { Config } from "../config/schema.js";
import type { FilesRepo } from "../db/filesRepo.js";
import type { JobsRepo } from "../db/jobsRepo.js";
import type { HistoryRepo } from "../db/historyRepo.js";
import type { LibraryWatcher } from "../scanner/watcher.js";
import type { ProcessorHandle } from "../queue/processor.js";
import type { RemoteWorkersRepo } from "../db/remoteWorkersRepo.js";

export interface AppContext {
  config: Config;
  configPath: string;
  filesRepo: FilesRepo;
  jobsRepo: JobsRepo;
  historyRepo: HistoryRepo;
  watcher?: LibraryWatcher;
  processor?: ProcessorHandle;
  remoteWorkersRepo?: RemoteWorkersRepo;
}

declare module "fastify" {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
