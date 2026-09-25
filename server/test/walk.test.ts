import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walkLibrary, walkLibraryEntries } from "../src/scanner/walk.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("walkLibrary", () => {
  it("discovers supported video files recursively and case-insensitively", async () => {
    const root = await mkdtemp(join(tmpdir(), "shrinkarr-walk-"));
    tempDirs.push(root);
    await mkdir(join(root, "performer", "session"), { recursive: true });
    await writeFile(join(root, "root.MP4"), "video");
    await writeFile(join(root, "performer", "session", "nested.mkv"), "video");
    await writeFile(join(root, "performer", "notes.txt"), "not video");

    const paths = await walkLibrary(root);

    expect(paths.sort()).toEqual([
      join(root, "performer", "session", "nested.mkv"),
      join(root, "root.MP4"),
    ].sort());
  });

  it("reports an inaccessible or missing library instead of treating it as empty", async () => {
    const missing = join(tmpdir(), `shrinkarr-missing-${Date.now()}`);

    await expect(walkLibrary(missing)).rejects.toThrow("Library path does not exist");
  });

  it("returns size and mtime from the walk and skips NAS metadata folders", async () => {
    const root = await mkdtemp(join(tmpdir(), "shrinkarr-walk-"));
    tempDirs.push(root);
    await mkdir(join(root, "@eaDir", "movie.mkv"), { recursive: true });
    await writeFile(join(root, "@eaDir", "movie.mkv", "SYNOVIDEO_VIDEO_SCREENSHOT.mp4"), "preview");
    await writeFile(join(root, "movie.mkv"), "12345");

    const entries = await walkLibraryEntries(root);

    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe(join(root, "movie.mkv"));
    expect(entries[0].sizeBytes).toBe(5);
    expect(entries[0].mtimeMs).toBeGreaterThan(0);
  });

  it("reports discovery progress while walking", async () => {
    const root = await mkdtemp(join(tmpdir(), "shrinkarr-walk-"));
    tempDirs.push(root);
    for (let i = 0; i < 3; i++) await writeFile(join(root, `m${i}.mkv`), "v");
    const counts: number[] = [];

    await walkLibraryEntries(root, "video", (found) => counts.push(found));

    expect(counts.at(-1)).toBe(3);
  });
});
