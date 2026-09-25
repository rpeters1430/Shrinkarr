import { openSync, closeSync, statSync, existsSync } from "node:fs";
import { open } from "node:fs/promises";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks if a file is currently locked or in use by another process.
 * Attempts to inspect file stat and access handle in read/write mode.
 */
export function checkFileLockOrBusy(filePath: string): { locked: boolean; reason?: string } {
  if (!existsSync(filePath)) {
    return { locked: false };
  }

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return { locked: false };
    }
  } catch (err) {
    return {
      locked: true,
      reason: `Cannot stat file: ${(err as NodeJS.ErrnoException).code || (err as Error).message}`,
    };
  }

  // Attempt to open the file handle to check for exclusive write locks (Windows / SMB / NFS / Linux)
  try {
    const fd = openSync(filePath, "r+");
    closeSync(fd);
    return { locked: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "ETXTBSY" || code === "EACCES") {
      // If permission denied for write (e.g. read-only filesystem or read-only mount), try opening read-only
      try {
        const readFd = openSync(filePath, "r");
        closeSync(readFd);
        return { locked: false };
      } catch (readErr) {
        const readCode = (readErr as NodeJS.ErrnoException).code;
        return {
          locked: true,
          reason: `File handle is locked or busy (${readCode || (readErr as Error).message})`,
        };
      }
    }
    return { locked: false };
  }
}

const LOCK_BUSY_CODES = new Set(["EBUSY", "EPERM", "ETXTBSY", "EACCES"]);

async function canOpen(filePath: string, flags: string): Promise<{ ok: true } | { ok: false; code?: string; message: string }> {
  try {
    const handle = await open(filePath, flags);
    await handle.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, code: (err as NodeJS.ErrnoException).code, message: (err as Error).message };
  }
}

/**
 * Same checks as checkFileLockOrBusy without blocking the event loop. A file
 * that can't be opened within `timeoutMs` (a stalled network share) is
 * reported as busy so the scan moves on.
 */
export async function checkFileLockOrBusyAsync(
  filePath: string,
  timeoutMs = 10_000,
): Promise<{ locked: boolean; reason?: string }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ locked: boolean; reason: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ locked: true, reason: `Opening the file took longer than ${Math.round(timeoutMs / 1000)}s` }),
      timeoutMs,
    );
  });

  const check = (async () => {
    const rw = await canOpen(filePath, "r+");
    if (rw.ok) return { locked: false };
    if (rw.code === "ENOENT" || !LOCK_BUSY_CODES.has(rw.code ?? "")) return { locked: false };
    // Read-only mounts refuse r+; the file is still usable if it opens for reading.
    const ro = await canOpen(filePath, "r");
    if (ro.ok) return { locked: false };
    return { locked: true, reason: `File handle is locked or busy (${ro.code || ro.message})` };
  })();

  try {
    return await Promise.race([check, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface WaitForFileStableOptions {
  settleDelaySeconds?: number;
  timeoutSeconds?: number;
  pollIntervalMs?: number;
}

/**
 * Timing system: Monitors file size and mtime over a stability window (`settleDelaySeconds`).
 * Ensures that downloading, copying, or actively locked files have finished writing and settled
 * before ffmpeg or ffprobe accesses them.
 */
export async function waitForFileStable(
  filePath: string,
  options: WaitForFileStableOptions = {},
): Promise<{ stable: boolean; size: number; reason?: string }> {
  const settleDelayMs = Math.max(500, (options.settleDelaySeconds ?? 15) * 1000);
  const timeoutMs = Math.max(settleDelayMs, (options.timeoutSeconds ?? 60) * 1000);
  const pollIntervalMs = Math.max(200, options.pollIntervalMs ?? 1000);

  const startTime = Date.now();
  let lastSize: number | null = null;
  let lastMtime: number | null = null;
  let stableSince: number | null = null;

  while (Date.now() - startTime < timeoutMs) {
    if (!existsSync(filePath)) {
      return { stable: false, size: 0, reason: "File does not exist" };
    }

    let currentSize: number;
    let currentMtime: number;

    try {
      const stat = statSync(filePath);
      currentSize = stat.size;
      currentMtime = stat.mtimeMs;
    } catch {
      // File could be temporarily locked during stat
      stableSince = null;
      await sleep(pollIntervalMs);
      continue;
    }

    const lockCheck = checkFileLockOrBusy(filePath);
    if (lockCheck.locked) {
      stableSince = null;
      await sleep(pollIntervalMs);
      continue;
    }

    const now = Date.now();
    const timeSinceLastModified = now - currentMtime;

    // If file has not been modified for longer than settleDelayMs and size is constant, it is already settled
    if (timeSinceLastModified >= settleDelayMs && (lastSize === null || lastSize === currentSize)) {
      return { stable: true, size: currentSize };
    }

    if (lastSize === currentSize && lastMtime === currentMtime) {
      if (stableSince === null) {
        stableSince = now;
      } else if (now - stableSince >= settleDelayMs) {
        // File has been stable and unlocked for the entire settle delay window!
        return { stable: true, size: currentSize };
      }
    } else {
      // Size or mtime changed - file is still actively being written or downloaded
      lastSize = currentSize;
      lastMtime = currentMtime;
      stableSince = now;
    }

    await sleep(Math.min(pollIntervalMs, settleDelayMs));
  }

  // If timeout occurred, check if size was stable for at least the settle window
  if (lastSize !== null && stableSince !== null && Date.now() - stableSince >= settleDelayMs) {
    return { stable: true, size: lastSize };
  }

  return {
    stable: false,
    size: lastSize ?? 0,
    reason: `File failed stability/unlock check within timeout (${Math.round(timeoutMs / 1000)}s). File may still be downloading, transferring, or locked by another process.`,
  };
}
