import { updateConfig, type Config } from "../config/index.js";
import { getActiveProcessor } from "../queue/processor.js";
import type { AppContext } from "./context.js";

/**
 * Persists a new config and pushes it to the long-running pieces that hold
 * their own reference to it. Without this, preset and library edits made in
 * the UI never reach the queue processor (jobs using a new preset fail with
 * "Unknown preset") and watcher toggles only apply after a restart.
 */
export function applyConfig(ctx: AppContext, newConfig: Config): void {
  const previous = ctx.config;
  updateConfig(newConfig);
  ctx.config = newConfig;

  const proc = ctx.processor || getActiveProcessor();
  proc?.updateConfig(newConfig);

  // Live watches are opened per library path, so library edits reopen them.
  const libraryPaths = (c: Config) => c.libraries.map((l) => `${l.id}=${l.path}`).join("\n");
  const watcherChanged =
    previous.watcher?.enabled !== newConfig.watcher?.enabled ||
    previous.watcher?.intervalMinutes !== newConfig.watcher?.intervalMinutes ||
    previous.watcher?.events !== newConfig.watcher?.events ||
    libraryPaths(previous) !== libraryPaths(newConfig);
  if (ctx.watcher && watcherChanged) {
    if (newConfig.watcher?.enabled) {
      ctx.watcher.start();
    } else {
      ctx.watcher.stop();
    }
  }
}
