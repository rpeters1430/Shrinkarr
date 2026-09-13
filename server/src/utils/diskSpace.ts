import { statfs } from "node:fs/promises";
import { dirname } from "node:path";

export async function getFreeDiskSpaceBytes(targetPath: string): Promise<number> {
  try {
    const stats = await statfs(targetPath);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    try {
      const stats = await statfs(dirname(targetPath));
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return Infinity;
    }
  }
}

export async function getTotalDiskSpaceBytes(targetPath: string): Promise<number> {
  try {
    const stats = await statfs(targetPath);
    return Number(stats.blocks) * Number(stats.bsize);
  } catch {
    try {
      const stats = await statfs(dirname(targetPath));
      return Number(stats.blocks) * Number(stats.bsize);
    } catch {
      return 0;
    }
  }
}
