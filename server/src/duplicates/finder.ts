import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { Library } from "../config/schema.js";
import type { FileRecord } from "../db/filesRepo.js";
import { runWithConcurrency } from "../utils/pool.js";
import { titleKeyFor } from "./titleKey.js";

export type DuplicateMatch = "identical" | "same-title";
export type HashMode = "sampled" | "full";

export interface DuplicateOptions {
  libraryIds?: string[];
  /** Byte-identical files, confirmed by hashing files of equal size. */
  findIdentical?: boolean;
  /** Same movie/episode/track under different encodes or names. */
  findSameTitle?: boolean;
  /** Same-title files whose runtimes differ by more than this are different cuts, not duplicates. */
  durationToleranceSeconds?: number;
  /** Ignore files smaller than this (samples, trailers). */
  minSizeMb?: number;
  /** When false, files only match others in the same library. */
  acrossLibraries?: boolean;
  /** "sampled" hashes 3 x 1 MiB per file; "full" reads every byte. */
  hashMode?: HashMode;
}

export interface DuplicateFile {
  path: string;
  libraryId: string;
  sizeBytes: number;
  durationSeconds: number;
  resolution: string;
  width: number;
  height: number;
  codec: string;
  bitrateKbps: number;
  bitDepth: number;
  isHdr: boolean;
  audioCodec: string;
  mtimeMs: number;
  keep: boolean;
}

export interface DuplicateGroup {
  id: string;
  match: DuplicateMatch;
  label: string;
  files: DuplicateFile[];
  reclaimableBytes: number;
}

export interface DuplicateReport {
  groups: DuplicateGroup[];
  filesChecked: number;
  reclaimableBytes: number;
  hashedFiles: number;
}

const SAMPLE_BYTES = 1024 * 1024;
const HASH_CONCURRENCY = 4;

async function sampledHash(path: string, size: number): Promise<string> {
  const hash = createHash("sha256");
  hash.update(String(size));
  const handle = await open(path, "r");
  try {
    const offsets = size <= SAMPLE_BYTES * 3
      ? [0]
      : [0, Math.floor(size / 2 - SAMPLE_BYTES / 2), size - SAMPLE_BYTES];
    const length = size <= SAMPLE_BYTES * 3 ? size : SAMPLE_BYTES;
    const buffer = Buffer.alloc(length);
    for (const offset of offsets) {
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function fullHash(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

const EFFICIENT_CODECS = new Set(["hevc", "h265", "av1", "vp9", "opus"]);

/** Higher is better. Resolution first, then HDR, bit depth, a modern codec and finally bitrate. */
function qualityScore(file: FileRecord): number[] {
  return [
    file.width * file.height,
    file.isHdr ? 1 : 0,
    file.bitDepth,
    EFFICIENT_CODECS.has(file.codec.toLowerCase()) ? 1 : 0,
    file.bitrateKbps,
  ];
}

function compareScores(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return b[i] - a[i];
  }
  return 0;
}

function toDuplicateFile(file: FileRecord, keep: boolean): DuplicateFile {
  return {
    path: file.path,
    libraryId: file.libraryId,
    sizeBytes: file.sizeBytes,
    durationSeconds: file.durationSeconds,
    resolution: file.resolution,
    width: file.width,
    height: file.height,
    codec: file.codec,
    bitrateKbps: file.bitrateKbps,
    bitDepth: file.bitDepth,
    isHdr: file.isHdr,
    audioCodec: file.audioCodec,
    mtimeMs: file.mtimeMs ?? 0,
    keep,
  };
}

function buildGroup(id: string, match: DuplicateMatch, label: string, files: FileRecord[]): DuplicateGroup {
  // Identical copies: keep the oldest (the one other tools most likely point
  // at). Different encodes: keep the best quality one.
  const ordered = [...files].sort((a, b) =>
    match === "identical"
      ? (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0) || a.path.length - b.path.length
      : compareScores(qualityScore(a), qualityScore(b)) || a.path.localeCompare(b.path),
  );
  const out = ordered.map((file, i) => toDuplicateFile(file, i === 0));
  return {
    id,
    match,
    label,
    files: out,
    reclaimableBytes: out.filter((f) => !f.keep).reduce((sum, f) => sum + f.sizeBytes, 0),
  };
}

function scopeKey(file: FileRecord, acrossLibraries: boolean): string {
  return acrossLibraries ? "" : `${file.libraryId}|`;
}

/**
 * Finds duplicate media among already-scanned files. Works from the scan
 * database, so a library has to be scanned before its files show up here.
 */
export async function findDuplicates(
  allFiles: FileRecord[],
  libraries: Library[],
  options: DuplicateOptions = {},
): Promise<DuplicateReport> {
  const findIdentical = options.findIdentical ?? true;
  const findSameTitle = options.findSameTitle ?? true;
  const tolerance = Math.max(0, options.durationToleranceSeconds ?? 90);
  const minBytes = Math.max(0, options.minSizeMb ?? 0) * 1024 * 1024;
  const acrossLibraries = options.acrossLibraries ?? true;
  const hashMode = options.hashMode ?? "sampled";
  const wanted = options.libraryIds?.length ? new Set(options.libraryIds) : null;
  const libraryById = new Map(libraries.map((l) => [l.id, l]));

  // Rows can outlive their files between scans; only report what is still on
  // disk. Hardlinks (common with Sonarr/Radarr imports) share one copy of the
  // data, so deleting one frees nothing: keep only the first path per inode.
  const candidates: FileRecord[] = [];
  const seenInodes = new Set<string>();
  await runWithConcurrency(
    allFiles.filter((f) => libraryById.has(f.libraryId) && (!wanted || wanted.has(f.libraryId)) && f.sizeBytes >= minBytes),
    16,
    async (file) => {
      try {
        const s = await stat(file.path);
        if (!s.isFile()) return;
        const inode = `${s.dev}:${s.ino}`;
        if (s.ino && seenInodes.has(inode)) return;
        seenInodes.add(inode);
        candidates.push({ ...file, sizeBytes: s.size });
      } catch {
        // missing; skip
      }
    },
  );
  candidates.sort((a, b) => a.path.localeCompare(b.path));

  const groups: DuplicateGroup[] = [];
  const identicalSets: Set<string>[] = [];
  let hashedFiles = 0;

  if (findIdentical) {
    const bySize = new Map<string, FileRecord[]>();
    for (const file of candidates) {
      if (file.sizeBytes <= 0) continue;
      const key = `${scopeKey(file, acrossLibraries)}${file.sizeBytes}`;
      const list = bySize.get(key) ?? [];
      list.push(file);
      bySize.set(key, list);
    }
    const toHash = [...bySize.values()].filter((list) => list.length > 1).flat();
    const hashes = new Map<string, string>();
    await runWithConcurrency(toHash, HASH_CONCURRENCY, async (file) => {
      try {
        hashes.set(file.path, hashMode === "full" ? await fullHash(file.path) : await sampledHash(file.path, file.sizeBytes));
        hashedFiles++;
      } catch (err) {
        console.warn(`[Duplicates] Could not read "${file.path}": ${(err as Error).message}`);
      }
    });

    const byHash = new Map<string, FileRecord[]>();
    for (const file of toHash) {
      const hash = hashes.get(file.path);
      if (!hash) continue;
      const key = `${scopeKey(file, acrossLibraries)}${hash}`;
      const list = byHash.get(key) ?? [];
      list.push(file);
      byHash.set(key, list);
    }
    for (const [key, list] of byHash) {
      if (list.length < 2) continue;
      const group = buildGroup(`identical:${key}`, "identical", "", list);
      const kept = group.files[0];
      group.label = titleKeyFor(kept.path, libraryById.get(kept.libraryId)?.mediaType ?? "movie").label;
      groups.push(group);
      identicalSets.push(new Set(list.map((f) => f.path)));
    }
  }

  if (findSameTitle) {
    const byTitle = new Map<string, { label: string; files: FileRecord[] }>();
    for (const file of candidates) {
      const title = titleKeyFor(file.path, libraryById.get(file.libraryId)?.mediaType ?? "movie");
      // An empty title means the name was only release tags; too vague to match on.
      if (title.key.endsWith("|") || title.key.includes("||")) continue;
      const key = `${scopeKey(file, acrossLibraries)}${title.key}`;
      const entry = byTitle.get(key) ?? { label: title.label, files: [] };
      entry.files.push(file);
      byTitle.set(key, entry);
    }

    for (const [key, { label, files }] of byTitle) {
      if (files.length < 2) continue;
      // Split by runtime so a theatrical cut and an extended cut stay separate.
      // Unknown runtimes (0) join the first cluster rather than being dropped.
      const known = files.filter((f) => f.durationSeconds > 0).sort((a, b) => a.durationSeconds - b.durationSeconds);
      const unknown = files.filter((f) => !(f.durationSeconds > 0));
      const clusters: FileRecord[][] = [];
      for (const file of known) {
        const current = clusters[clusters.length - 1];
        if (current && file.durationSeconds - current[0].durationSeconds <= tolerance) {
          current.push(file);
        } else {
          clusters.push([file]);
        }
      }
      if (unknown.length > 0) {
        if (clusters.length > 0) clusters[0].push(...unknown);
        else clusters.push(unknown);
      }

      clusters.forEach((cluster, i) => {
        if (cluster.length < 2) return;
        // Already reported as byte-identical; don't list the same set twice.
        if (identicalSets.some((set) => cluster.every((f) => set.has(f.path)))) return;
        groups.push(buildGroup(`same-title:${key}:${i}`, "same-title", label, cluster));
      });
    }
  }

  groups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
  // A file can sit in an identical group and a same-title group; count it once.
  const removable = new Map<string, number>();
  for (const group of groups) {
    for (const file of group.files) if (!file.keep) removable.set(file.path, file.sizeBytes);
  }
  return {
    groups,
    filesChecked: candidates.length,
    reclaimableBytes: [...removable.values()].reduce((sum, size) => sum + size, 0),
    hashedFiles,
  };
}
