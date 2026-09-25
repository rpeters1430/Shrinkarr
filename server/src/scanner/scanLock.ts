// Full scans and watcher sweeps share one progress tracker and probe the same
// files, so only one may run at a time.
let held = false;
const waiters: Array<() => void> = [];

function release(): void {
  const next = waiters.shift();
  if (next) {
    next();
  } else {
    held = false;
  }
}

/** Waits for the scan slot. Call the returned function to give it back. */
export function acquireScanLock(): Promise<() => void> {
  if (!held) {
    held = true;
    return Promise.resolve(release);
  }
  return new Promise((resolve) => waiters.push(() => resolve(release)));
}

/** Takes the scan slot only if it's free. */
export function tryAcquireScanLock(): (() => void) | null {
  if (held) return null;
  held = true;
  return release;
}

export function isScanLockHeld(): boolean {
  return held;
}
