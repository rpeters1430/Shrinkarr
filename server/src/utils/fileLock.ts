import { openSync, closeSync, statSync, existsSync } from "node:fs";

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
