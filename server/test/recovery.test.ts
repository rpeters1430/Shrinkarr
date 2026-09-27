import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "../src/config/loader.js";
import type { Config } from "../src/config/schema.js";
import { recoverInterruptedWork } from "../src/queue/recovery.js";

let root: string;
let config: Config;

const longAgo = new Date("2020-01-01T00:00:00Z");

function writeMarker(originalPath: string, phase: string, destination: string): void {
  writeFileSync(`${originalPath}.shrinkarr.bak.txn`, JSON.stringify({ phase, originalPath, destination }));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "shrinkarr-recovery-"));
  mkdirSync(join(root, "lib"));
  config = getDefaultConfig();
  config.libraries = [
    { id: "lib", name: "Lib", path: join(root, "lib"), mediaType: "movie", presetId: config.presets[0].id, autoOptimize: false },
  ];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("recoverInterruptedWork", () => {
  it("restores an original whose replacement never landed", async () => {
    const original = join(root, "lib", "movie.mkv");
    writeFileSync(`${original}.shrinkarr.bak`, "original");

    const report = await recoverInterruptedWork(config);

    expect(readFileSync(original, "utf-8")).toBe("original");
    expect(existsSync(`${original}.shrinkarr.bak`)).toBe(false);
    expect(report.restored).toHaveLength(1);
  });

  it("drops the backup when the marker says the replacement was installed", async () => {
    const original = join(root, "lib", "movie.mkv");
    writeFileSync(original, "new encode");
    writeFileSync(`${original}.shrinkarr.bak`, "original");
    writeMarker(original, "installed", original);

    await recoverInterruptedWork(config);

    expect(readFileSync(original, "utf-8")).toBe("new encode");
    expect(existsSync(`${original}.shrinkarr.bak`)).toBe(false);
    expect(existsSync(`${original}.shrinkarr.bak.txn`)).toBe(false);
  });

  it("moves the backup to the recycle bin when one is configured", async () => {
    const original = join(root, "lib", "movie.mkv");
    writeFileSync(original, "new encode");
    writeFileSync(`${original}.shrinkarr.bak`, "original");
    writeMarker(original, "installed", original);
    config.queue.recycleBinPath = join(root, "bin");

    await recoverInterruptedWork(config);

    expect(readdirSync(join(root, "bin"))).toHaveLength(1);
  });

  it("finishes an installed container change", async () => {
    const original = join(root, "lib", "movie.mkv");
    const replacement = join(root, "lib", "movie.mp4");
    writeFileSync(`${original}.shrinkarr.bak`, "original");
    writeFileSync(replacement, "new encode");
    writeMarker(original, "installed", replacement);

    await recoverInterruptedWork(config);

    expect(existsSync(original)).toBe(false);
    expect(existsSync(`${original}.shrinkarr.bak`)).toBe(false);
    expect(readFileSync(replacement, "utf-8")).toBe("new encode");
  });

  it("restores the original when the marker never reached installed, even if a newer sibling exists", async () => {
    const original = join(root, "lib", "movie.mkv");
    writeFileSync(`${original}.shrinkarr.bak`, "original");
    utimesSync(`${original}.shrinkarr.bak`, longAgo, longAgo);
    writeFileSync(join(root, "lib", "movie.mp4"), "someone else's newer file");
    writeMarker(original, "backed-up", original);

    await recoverInterruptedWork(config);

    expect(readFileSync(original, "utf-8")).toBe("original");
    expect(readFileSync(join(root, "lib", "movie.mp4"), "utf-8")).toBe("someone else's newer file");
  });

  it("keeps both files when something is at the original path but nothing confirms the replacement", async () => {
    const original = join(root, "lib", "movie.mkv");
    writeFileSync(original, "unknown");
    writeFileSync(`${original}.shrinkarr.bak`, "original");

    const report = await recoverInterruptedWork(config);

    expect(readFileSync(`${original}.shrinkarr.bak`, "utf-8")).toBe("original");
    expect(report.keptBackups).toHaveLength(1);
  });

  it("does not mistake a subtitle sidecar for the replacement", async () => {
    const original = join(root, "lib", "movie.mkv");
    writeFileSync(`${original}.shrinkarr.bak`, "original");
    utimesSync(`${original}.shrinkarr.bak`, longAgo, longAgo);
    writeFileSync(join(root, "lib", "movie.srt"), "subs");

    await recoverInterruptedWork(config);

    expect(readFileSync(original, "utf-8")).toBe("original");
  });

  it("removes staging copies and unfinished encodes from libraries and the temp directory", async () => {
    const staging = join(root, "lib", "movie.mkv.shrinkarr.staging.123");
    const libTemp = join(root, "lib", "movie.shrinkarr.tmp.mkv");
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    const scratchTemp = join(scratch, "movie-1700000000000.shrinkarr.tmp.mkv");
    const unrelated = join(scratch, "someone-elses-file.mkv");
    for (const p of [staging, libTemp, scratchTemp, unrelated]) writeFileSync(p, "x");
    config.queue.tempDirectory = scratch;

    const report = await recoverInterruptedWork(config);

    expect(existsSync(staging)).toBe(false);
    expect(existsSync(libTemp)).toBe(false);
    expect(existsSync(scratchTemp)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(report.removedTempFiles).toHaveLength(3);
  });
});
