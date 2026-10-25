import { createReadStream, createWriteStream } from "node:fs";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { cleanupTemp } from "./atomicReplace.js";

// Large reads keep a network share streaming instead of answering thousands
// of small requests.
const CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Where a job's local copy of its source goes. The name carries tempSuffix
 * so startup recovery deletes copies left behind by a crash.
 */
export function buildStagedSourcePath(originalPath: string, jobId: string, tempSuffix: string, stagingDirectory: string): string {
  const ext = extname(originalPath);
  return join(stagingDirectory, `${basename(originalPath, ext)}-${jobId}.source${tempSuffix}${ext}`);
}

/**
 * Copies a file in one sequential pass. A cancelled or failed copy removes
 * the partial destination, and an existing destination is never overwritten.
 */
export async function copyFileSequential(
  sourcePath: string,
  destinationPath: string,
  options: { signal?: AbortSignal; onProgress?: (copiedBytes: number) => void } = {},
): Promise<number> {
  let copied = 0;
  try {
    await pipeline(
      createReadStream(sourcePath, { highWaterMark: CHUNK_BYTES }),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          copied += chunk.length;
          options.onProgress?.(copied);
          yield chunk;
        }
      },
      createWriteStream(destinationPath, { flags: "wx", highWaterMark: CHUNK_BYTES }),
      { signal: options.signal },
    );
  } catch (err) {
    // "wx" failing means the file belongs to someone else; leave it.
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") await cleanupTemp(destinationPath);
    throw err;
  }
  return copied;
}
