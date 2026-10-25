import { resolve } from "node:path";

// Filesystem events can arrive a while after the operation, especially from
// an SMB server, so a path stays quiet for this long after a job lets go.
const GRACE_MS = 60_000;

// Paths a running job is reading or replacing, with a reference count, and
// the time each released path stops being ignored.
const held = new Map<string, number>();
const releasedUntil = new Map<string, number>();

function keyOf(path: string): string {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

/**
 * Marks paths a job reads or replaces so the watcher skips their events.
 * Call the returned function when the job is done with them.
 */
export function holdSelfWritePaths(paths: string[]): () => void {
  const keys = [...new Set(paths.map(keyOf))];
  for (const key of keys) held.set(key, (held.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const until = Date.now() + GRACE_MS;
    for (const key of keys) {
      const count = (held.get(key) ?? 1) - 1;
      if (count > 0) held.set(key, count);
      else held.delete(key);
      releasedUntil.set(key, until);
    }
  };
}

export function isSelfWritePath(path: string, now = Date.now()): boolean {
  const key = keyOf(path);
  if (held.has(key)) return true;
  const until = releasedUntil.get(key);
  if (until === undefined) return false;
  if (now < until) return true;
  releasedUntil.delete(key);
  return false;
}

export function resetSelfWritePaths(): void {
  held.clear();
  releasedUntil.clear();
}
