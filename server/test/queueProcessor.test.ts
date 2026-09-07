import { describe, expect, it } from "vitest";
import { isWithinSchedule } from "../src/queue/processor.js";

describe("Queue schedule time window", () => {
  it("returns true if schedule is undefined or not enabled", () => {
    expect(isWithinSchedule(undefined)).toBe(true);
    expect(isWithinSchedule({ enabled: false, startHour: 1, endHour: 7 })).toBe(true);
  });

  it("handles daylight / daytime window correctly", () => {
    const currentHour = new Date().getHours();
    const activeSchedule = {
      enabled: true,
      startHour: currentHour,
      endHour: (currentHour + 1) % 24,
    };
    expect(isWithinSchedule(activeSchedule)).toBe(true);

    const inactiveSchedule = {
      enabled: true,
      startHour: (currentHour + 2) % 24,
      endHour: (currentHour + 3) % 24,
    };
    expect(isWithinSchedule(inactiveSchedule)).toBe(false);
  });

  it("handles overnight window spanning midnight", () => {
    const schedule = {
      enabled: true,
      startHour: 23,
      endHour: 6,
    };
    const currentHour = new Date().getHours();
    const expected = currentHour >= 23 || currentHour < 6;
    expect(isWithinSchedule(schedule)).toBe(expected);
  });
});

describe("Queue Processor Dynamic Concurrency & Runners", () => {
  it("manages concurrency changes dynamically", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { openDb } = await import("../src/db/client.js");
    const { JobsRepo } = await import("../src/db/jobsRepo.js");
    const { FilesRepo } = await import("../src/db/filesRepo.js");
    const { startProcessor } = await import("../src/queue/processor.js");

    const dir = mkdtempSync(join(tmpdir(), "shrinkarr-proc-test-"));
    const db = openDb(join(dir, "test.db"));
    const jobsRepo = new JobsRepo(db);
    const filesRepo = new FilesRepo(db);

    const mockConfig = {
      apiKey: "test",
      dbPath: join(dir, "test.db"),
      libraries: [],
      presets: [{ id: "balanced", name: "Balanced", targetCodec: "hevc" as const, targetContainer: "mkv" as const, crf: 24, hwaccel: "auto" as const }],
      queue: { concurrency: 1, tempSuffix: ".shrinkarr-temp", pauseOnStreaming: false },
      integrations: {},
    };

    const handle = startProcessor({ config: mockConfig, filesRepo, jobsRepo }, 1);
    expect(handle.getConcurrency()).toBe(1);

    handle.setConcurrency(3);
    expect(handle.getConcurrency()).toBe(3);
    expect(mockConfig.queue.concurrency).toBe(3);

    handle.setConcurrency(1);
    expect(handle.getConcurrency()).toBe(1);
    expect(mockConfig.queue.concurrency).toBe(1);

    handle.stop();
    db.close();
  });
});
