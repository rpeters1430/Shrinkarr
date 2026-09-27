import { describe, expect, it, vi } from "vitest";
import { applyConfig } from "../src/api/applyConfig.js";
import type { AppContext } from "../src/api/context.js";
import { ConfigSchema, type Config } from "../src/config/schema.js";
import type { ProcessorHandle } from "../src/queue/processor.js";
import type { LibraryWatcher } from "../src/scanner/watcher.js";

vi.mock("../src/config/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/index.js")>()),
  updateConfig: vi.fn(),
}));

function makeCtx(config: Config) {
  const processor = { updateConfig: vi.fn() } as unknown as ProcessorHandle;
  const watcher = { start: vi.fn(), stop: vi.fn() } as unknown as LibraryWatcher;
  const ctx = { config, configPath: "x", processor, watcher } as unknown as AppContext;
  return { ctx, processor, watcher };
}

describe("applyConfig", () => {
  it("hands preset changes to the running queue processor", () => {
    const { ctx, processor } = makeCtx(ConfigSchema.parse({}));
    const next = { ...ctx.config, presets: [...ctx.config.presets, { ...ctx.config.presets[0], id: "custom" }] };

    applyConfig(ctx, next);

    expect(ctx.config).toBe(next);
    expect(processor.updateConfig).toHaveBeenCalledWith(next);
  });

  it("stops and restarts the watcher when it is toggled", () => {
    const base = ConfigSchema.parse({ watcher: { enabled: true } });
    const { ctx, watcher } = makeCtx(base);

    applyConfig(ctx, { ...base, watcher: { ...base.watcher, enabled: false } });
    expect(watcher.stop).toHaveBeenCalledTimes(1);

    applyConfig(ctx, { ...base, watcher: { ...base.watcher, enabled: true } });
    expect(watcher.start).toHaveBeenCalledTimes(1);
  });

  it("leaves the watcher alone when its settings are unchanged", () => {
    const base = ConfigSchema.parse({});
    const { ctx, watcher } = makeCtx(base);
    applyConfig(ctx, { ...base, libraries: [] });
    expect(watcher.start).not.toHaveBeenCalled();
    expect(watcher.stop).not.toHaveBeenCalled();
  });
});
