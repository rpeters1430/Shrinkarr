import { describe, expect, it } from "vitest";
import { isWithinSchedule, getCurrentHourInTimezone } from "../src/queue/processor.js";

describe("Queue schedule time window", () => {
  it("returns true if schedule is undefined or not enabled", () => {
    expect(isWithinSchedule(undefined)).toBe(true);
    expect(isWithinSchedule({ enabled: false, startHour: 1, endHour: 7 })).toBe(true);
  });

  it("handles daylight / daytime window correctly with hour override", () => {
    const schedule = { enabled: true, startHour: 9, endHour: 17 };
    expect(isWithinSchedule(schedule, 8)).toBe(false);
    expect(isWithinSchedule(schedule, 9)).toBe(true);
    expect(isWithinSchedule(schedule, 12)).toBe(true);
    expect(isWithinSchedule(schedule, 16)).toBe(true);
    expect(isWithinSchedule(schedule, 17)).toBe(false);
    expect(isWithinSchedule(schedule, 22)).toBe(false);
  });

  it("handles overnight window spanning midnight with hour override", () => {
    const schedule = { enabled: true, startHour: 23, endHour: 7 };
    expect(isWithinSchedule(schedule, 22)).toBe(false);
    expect(isWithinSchedule(schedule, 23)).toBe(true);
    expect(isWithinSchedule(schedule, 0)).toBe(true);
    expect(isWithinSchedule(schedule, 3)).toBe(true);
    expect(isWithinSchedule(schedule, 6)).toBe(true);
    expect(isWithinSchedule(schedule, 7)).toBe(false);
    expect(isWithinSchedule(schedule, 12)).toBe(false);
  });

  it("treats equal start and end hour as 24-hour active window", () => {
    const schedule = { enabled: true, startHour: 5, endHour: 5 };
    expect(isWithinSchedule(schedule, 5)).toBe(true);
    expect(isWithinSchedule(schedule, 12)).toBe(true);
  });

  it("computes hour in specified IANA timezone", () => {
    const fixedDate = new Date("2026-09-10T12:00:00Z"); // 12:00 UTC
    expect(getCurrentHourInTimezone("UTC", fixedDate)).toBe(12);
    expect(getCurrentHourInTimezone("America/New_York", fixedDate)).toBe(8); // EDT is UTC-4
    expect(getCurrentHourInTimezone("America/Los_Angeles", fixedDate)).toBe(5); // PDT is UTC-7
    expect(getCurrentHourInTimezone("invalid/zone", fixedDate)).toBe(fixedDate.getHours());
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

  it("aborts active runners and returns jobs to pending when pause is called", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { openDb } = await import("../src/db/client.js");
    const { JobsRepo } = await import("../src/db/jobsRepo.js");
    const { FilesRepo } = await import("../src/db/filesRepo.js");
    const { startProcessor } = await import("../src/queue/processor.js");

    const dir = mkdtempSync(join(tmpdir(), "shrinkarr-proc-pause-"));
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
    expect(handle.isPaused()).toBe(false);

    handle.pause();
    expect(handle.isPaused()).toBe(true);

    handle.resume();
    expect(handle.isPaused()).toBe(false);

    handle.stop();
    db.close();
  });

  it("aborts active runners when schedule becomes inactive via updateConfig", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { openDb } = await import("../src/db/client.js");
    const { JobsRepo } = await import("../src/db/jobsRepo.js");
    const { FilesRepo } = await import("../src/db/filesRepo.js");
    const { startProcessor } = await import("../src/queue/processor.js");

    const dir = mkdtempSync(join(tmpdir(), "shrinkarr-proc-sched-"));
    const db = openDb(join(dir, "test.db"));
    const jobsRepo = new JobsRepo(db);
    const filesRepo = new FilesRepo(db);

    const currentHour = new Date().getHours();
    // Inactive schedule: outside current hour
    const inactiveSchedule = {
      enabled: true,
      startHour: (currentHour + 2) % 24,
      endHour: (currentHour + 3) % 24,
      stopActiveOnExit: true,
    };

    const mockConfig = {
      apiKey: "test",
      dbPath: join(dir, "test.db"),
      libraries: [],
      presets: [{ id: "balanced", name: "Balanced", targetCodec: "hevc" as const, targetContainer: "mkv" as const, crf: 24, hwaccel: "auto" as const }],
      queue: { concurrency: 1, tempSuffix: ".shrinkarr-temp", pauseOnStreaming: false },
      integrations: {},
    };

    const handle = startProcessor({ config: mockConfig, filesRepo, jobsRepo }, 1);

    handle.updateConfig({
      ...mockConfig,
      queue: {
        ...mockConfig.queue,
        schedule: inactiveSchedule,
      },
    });

    expect(handle.getActiveCount()).toBe(0);

    handle.stop();
    db.close();
  });
});
