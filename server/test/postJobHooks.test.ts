import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPostJobHooks } from "../src/queue/postJobHooks.js";
import type { Config } from "../src/config/schema.js";
import type { Job } from "../src/db/jobsRepo.js";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseConfig: Config = {
  libraries: [],
  presets: [],
  integrations: {
    jellyfin: { url: "http://jellyfin:8096", apiKey: "jf-key" },
    sonarr: { url: "http://sonarr:8989", apiKey: "sonarr-key" },
  },
  queue: { concurrency: 1, tempSuffix: ".shrinkarr.tmp" },
  dbPath: "unused.db",
};

const doneJob: Job = {
  id: "job-1",
  filePath: "/media/movie.mkv",
  presetId: "preset-1",
  status: "done",
  progressPercent: 100,
  error: null,
  originalSizeBytes: 1000,
  newSizeBytes: 600,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("runPostJobHooks", () => {
  it("calls all configured clients on a successful job", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await runPostJobHooks(doneJob, baseConfig);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not throw when a hook fails", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: "Error", text: async () => "boom" });
    fetchMock.mockResolvedValueOnce({ ok: true });
    await expect(runPostJobHooks(doneJob, baseConfig)).resolves.toBeUndefined();
  });

  it("does not call any hooks when the job failed", async () => {
    const failedJob: Job = { ...doneJob, status: "failed", error: "transcode failed" };
    await runPostJobHooks(failedJob, baseConfig);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
