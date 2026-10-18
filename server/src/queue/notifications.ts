import { basename } from "node:path";
import type { Notifications } from "../config/schema.js";
import type { Job } from "../db/jobsRepo.js";

export type NotificationEvent = "job_done" | "job_failed" | "queue_empty" | "test";

export interface Notification {
  event: NotificationEvent;
  title: string;
  message: string;
  job?: Job;
}

const SEND_TIMEOUT_MS = 10_000;

const DISCORD_COLORS: Record<NotificationEvent, number> = {
  job_done: 0x10b981,
  job_failed: 0xf43f5e,
  queue_empty: 0x6366f1,
  test: 0x6366f1,
};

const NTFY_TAGS: Record<NotificationEvent, string> = {
  job_done: "white_check_mark",
  job_failed: "x",
  queue_empty: "checkered_flag",
  test: "bell",
};

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function hasNotificationTargets(settings: Notifications | undefined): boolean {
  return Boolean(
    present(settings?.discordWebhookUrl) || present(settings?.ntfyUrl) || present(settings?.webhookUrl),
  );
}

async function post(url: string, init: RequestInit, target: string): Promise<void> {
  const res = await fetch(url, { method: "POST", ...init, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`${target} returned ${res.status} ${res.statusText}`);
  }
}

/**
 * Sends one notification to every configured target. Returns the error message
 * for each target that failed; an empty array means everything was delivered.
 */
export async function sendNotification(settings: Notifications | undefined, notification: Notification): Promise<string[]> {
  const sends: Array<{ target: string; send: () => Promise<void> }> = [];

  const discordUrl = present(settings?.discordWebhookUrl);
  if (discordUrl) {
    sends.push({
      target: "Discord",
      send: () => post(discordUrl, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "Shrinkarr",
          embeds: [{
            title: notification.title,
            description: notification.message,
            color: DISCORD_COLORS[notification.event],
          }],
        }),
      }, "Discord"),
    });
  }

  const ntfyUrl = present(settings?.ntfyUrl);
  if (ntfyUrl) {
    // HTTP headers only carry Latin-1, so file names (which may not) stay in the body.
    const headers: Record<string, string> = {
      Title: notification.title,
      Tags: NTFY_TAGS[notification.event],
    };
    if (notification.event === "job_failed") headers.Priority = "high";
    const token = present(settings?.ntfyToken);
    if (token) headers.Authorization = `Bearer ${token}`;
    sends.push({
      target: "ntfy",
      send: () => post(ntfyUrl, { headers, body: notification.message }, "ntfy"),
    });
  }

  const webhookUrl = present(settings?.webhookUrl);
  if (webhookUrl) {
    sends.push({
      target: "Webhook",
      send: () => post(webhookUrl, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: notification.event,
          title: notification.title,
          message: notification.message,
          job: notification.job,
        }),
      }, "Webhook"),
    });
  }

  const results = await Promise.allSettled(sends.map(({ send }) => send()));
  const errors: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(`${sends[i].target}: ${reason}`);
    }
  });
  return errors;
}

export function jobDoneNotification(job: Job): Notification {
  const saved = (job.originalSizeBytes ?? 0) - (job.newSizeBytes ?? 0);
  const percent = job.originalSizeBytes ? Math.round((saved / job.originalSizeBytes) * 100) : 0;
  const sizes = job.originalSizeBytes && job.newSizeBytes != null
    ? `\n${formatBytes(job.originalSizeBytes)} → ${formatBytes(job.newSizeBytes)} (saved ${formatBytes(saved)}, ${percent}%)`
    : "";
  return {
    event: "job_done",
    title: "Transcode finished",
    message: `${basename(job.filePath)}${sizes}`,
    job,
  };
}

export function jobFailedNotification(job: Job): Notification {
  return {
    event: "job_failed",
    title: "Transcode failed",
    message: `${basename(job.filePath)}\n${job.error ?? "No error message recorded"}`,
    job,
  };
}

export function queueEmptyNotification(done: number, failed: number, savedBytes: number): Notification {
  const parts = [`${done} finished`];
  if (failed > 0) parts.push(`${failed} failed`);
  return {
    event: "queue_empty",
    title: "Queue finished",
    message: `${parts.join(", ")}. Saved ${formatBytes(savedBytes)}.`,
  };
}

/**
 * Tracks job outcomes for one queue processor so it can alert on each job and
 * send a summary once the queue runs dry.
 */
export class QueueNotifier {
  private done = 0;
  private failed = 0;
  private savedBytes = 0;

  jobFinished(job: Job | undefined, settings: Notifications | undefined): void {
    if (!job) return;
    if (job.status === "done") {
      this.done++;
      this.savedBytes += Math.max(0, (job.originalSizeBytes ?? 0) - (job.newSizeBytes ?? 0));
      if (settings?.onJobDone) this.deliver(settings, jobDoneNotification(job));
    } else if (job.status === "failed") {
      this.failed++;
      if (settings?.onJobFailed) this.deliver(settings, jobFailedNotification(job));
    }
  }

  // Called when nothing is running and nothing is pending.
  queueIdle(settings: Notifications | undefined): void {
    if (this.done === 0 && this.failed === 0) return;
    const summary = queueEmptyNotification(this.done, this.failed, this.savedBytes);
    this.done = 0;
    this.failed = 0;
    this.savedBytes = 0;
    if (settings?.onQueueEmpty) this.deliver(settings, summary);
  }

  private deliver(settings: Notifications, notification: Notification): void {
    if (!hasNotificationTargets(settings)) return;
    void sendNotification(settings, notification).then((errors) => {
      for (const error of errors) {
        console.warn(`[Notifications] Could not send "${notification.title}": ${error}`);
      }
    });
  }
}
