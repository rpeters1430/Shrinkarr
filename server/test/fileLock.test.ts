import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFileLockOrBusy, waitForFileStable } from "../src/utils/fileLock.js";

describe("fileLock and stability timing system", () => {
  it("detects when a file is accessible", () => {
    const dir = mkdtempSync(join(tmpdir(), "shrinkarr-lock-"));
    const file = join(dir, "video.mkv");
    writeFileSync(file, "hello video");

    const check = checkFileLockOrBusy(file);
    expect(check.locked).toBe(false);
  });

  it("waits for file to be stable when size does not change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shrinkarr-lock-"));
    const file = join(dir, "stable-video.mkv");
    writeFileSync(file, "stable video content");

    const result = await waitForFileStable(file, {
      settleDelaySeconds: 1,
      timeoutSeconds: 3,
      pollIntervalMs: 200,
    });

    expect(result.stable).toBe(true);
    expect(result.size).toBeGreaterThan(0);
  });

  it("handles actively growing files and succeeds once writing finishes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shrinkarr-lock-"));
    const file = join(dir, "growing-video.mkv");
    writeFileSync(file, "chunk 1");

    // Simulate active downloading / writing
    setTimeout(() => {
      appendFileSync(file, " + chunk 2");
    }, 400);

    const result = await waitForFileStable(file, {
      settleDelaySeconds: 1,
      timeoutSeconds: 4,
      pollIntervalMs: 200,
    });

    expect(result.stable).toBe(true);
    expect(result.size).toBe("chunk 1 + chunk 2".length);
  });
});
