import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueueNotifier, sendNotification } from "../src/queue/notifications.js";
import type { Notifications } from "../src/config/schema.js";
import type { Job } from "../src/db/jobsRepo.js";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseJob: Job = {
  id: "job-1",
  filePath: "/media/movies/Movie (2020).mkv",
  presetId: "balanced",
  status: "done",
  progressPercent: 100,
  fps: 0,
  speed: "0x",
  encoderUsed: null,
  fallbackReason: null,
  error: null,
  originalSizeBytes: 4 * 1024 ** 3,
  newSizeBytes: 1024 ** 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const allEvents: Notifications = {
  ntfyUrl: "https://ntfy.example/shrinkarr",
  onJobDone: true,
  onJobFailed: true,
  onQueueEmpty: true,
};

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("sendNotification", () => {
  it("posts to every configured target and skips blank ones", async () => {
    const errors = await sendNotification(
      {
        discordWebhookUrl: "https://discord.example/hook",
        ntfyUrl: "https://ntfy.example/topic",
        ntfyToken: "tk_secret",
        webhookUrl: "  ",
        onJobDone: false,
        onJobFailed: true,
        onQueueEmpty: true,
      },
      { event: "test", title: "Hello", message: "Body" },
    );
    expect(errors).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [discordUrl, discordInit] = fetchMock.mock.calls[0];
    expect(discordUrl).toBe("https://discord.example/hook");
    expect(JSON.parse(discordInit.body).embeds[0]).toMatchObject({ title: "Hello", description: "Body" });

    const [ntfyUrl, ntfyInit] = fetchMock.mock.calls[1];
    expect(ntfyUrl).toBe("https://ntfy.example/topic");
    expect(ntfyInit.headers).toMatchObject({ Title: "Hello", Authorization: "Bearer tk_secret" });
    expect(ntfyInit.body).toBe("Body");
  });

  it("reports failed targets instead of throwing", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, statusText: "Not Found" });
    const errors = await sendNotification(
      { webhookUrl: "https://hook.example", onJobDone: false, onJobFailed: true, onQueueEmpty: true },
      { event: "test", title: "Hello", message: "Body" },
    );
    expect(errors).toEqual(["Webhook: Webhook returned 404 Not Found"]);
  });
});

describe("QueueNotifier", () => {
  it("sends per-job messages only for enabled events", async () => {
    const notifier = new QueueNotifier();
    notifier.jobFinished(baseJob, { ...allEvents, onJobDone: false });
    notifier.jobFinished({ ...baseJob, status: "failed", error: "Transcode failed: boom" }, allEvents);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].body).toContain("Transcode failed: boom");
  });

  it("ignores cancelled and rescheduled jobs", async () => {
    const notifier = new QueueNotifier();
    notifier.jobFinished({ ...baseJob, status: "cancelled" }, allEvents);
    notifier.jobFinished({ ...baseJob, status: "pending" }, allEvents);
    notifier.queueIdle(allEvents);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends one queue summary after work, then stays quiet while idle", async () => {
    const notifier = new QueueNotifier();
    const quiet = { ...allEvents, onJobDone: false, onJobFailed: false };
    notifier.jobFinished(baseJob, quiet);
    notifier.jobFinished({ ...baseJob, id: "job-2", status: "failed", error: "x" }, quiet);
    notifier.queueIdle(quiet);
    notifier.queueIdle(quiet);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].body).toBe("1 finished, 1 failed. Saved 3.0 GB.");
  });

  it("does nothing without targets", async () => {
    const notifier = new QueueNotifier();
    notifier.jobFinished({ ...baseJob, status: "failed" }, { onJobDone: true, onJobFailed: true, onQueueEmpty: true });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
