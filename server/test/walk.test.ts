import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walkLibrary } from "../src/scanner/walk.js";

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
});
