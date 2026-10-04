import { statfs } from "node:fs/promises";
import { dirname } from "node:path";

export interface DiskSpaceInfo {
  freeBytes: number;
  totalBytes: number;
}

export async function getDiskSpaceInfo(targetPath: string): Promise<DiskSpaceInfo> {
  try {
    const stats = await statfs(targetPath);
    return {
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
    };
  } catch {
    try {
      const stats = await statfs(dirname(targetPath));
      return {
        freeBytes: Number(stats.bavail) * Number(stats.bsize),
        totalBytes: Number(stats.blocks) * Number(stats.bsize),
      };
    } catch {
      return {
        freeBytes: Infinity,
        totalBytes: 0,
      };
    }
  }
}

export async function getFreeDiskSpaceBytes(targetPath: string): Promise<number> {
  const info = await getDiskSpaceInfo(targetPath);
  return info.freeBytes;
}

export async function getTotalDiskSpaceBytes(targetPath: string): Promise<number> {
  const info = await getDiskSpaceInfo(targetPath);
  return info.totalBytes;
}
