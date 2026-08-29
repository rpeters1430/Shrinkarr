export interface ScanProgress {
  isScanning: boolean;
  libraryId?: string;
  libraryName?: string;
  phase: "idle" | "discovering" | "probing" | "complete";
  statusText?: string;
  current: number;
  total: number;
  percent: number;
  currentFile?: string;
  recommendedCount: number;
  totalSavingsBytes: number;
  startedAt?: string;
  completedAt?: string;
  lastSummary?: string;
  queueLength?: number;
  activeLibraryIndex?: number;
  totalLibraries?: number;
}

let activeScan: ScanProgress = {
  isScanning: false,
  phase: "idle",
  current: 0,
  total: 0,
  percent: 0,
  recommendedCount: 0,
  totalSavingsBytes: 0,
};

export function getScanProgress(): ScanProgress {
  return activeScan;
}

export function startScanProgress(
  libraryId: string,
  libraryName: string,
  totalLibraries = 1,
  activeLibraryIndex = 1,
): void {
  activeScan = {
    isScanning: true,
    libraryId,
    libraryName,
    phase: "discovering",
    statusText: `Crawling directory for "${libraryName}"...`,
    current: 0,
    total: 0,
    percent: 0,
    currentFile: "Discovering media files...",
    recommendedCount: 0,
    totalSavingsBytes: 0,
    startedAt: new Date().toISOString(),
    completedAt: undefined,
    queueLength: Math.max(0, totalLibraries - activeLibraryIndex),
    activeLibraryIndex,
    totalLibraries,
  };
}

export function setScanTotal(total: number): void {
  if (!activeScan.isScanning) return;
  activeScan.total = total;
  activeScan.phase = total === 0 ? "complete" : "probing";
  activeScan.percent = total === 0 ? 100 : 0;
  activeScan.statusText =
    total === 0
      ? "No media files discovered"
      : `Probing ${total} file(s) with ffprobe...`;
}

export function updateScanStep(
  current: number,
  currentFile: string,
  isRecommended: boolean,
  savingsBytes = 0,
): void {
  if (!activeScan.isScanning) return;
  activeScan.phase = "probing";
  activeScan.current = current;
  activeScan.currentFile = currentFile;
  if (isRecommended) {
    activeScan.recommendedCount += 1;
    activeScan.totalSavingsBytes += savingsBytes;
  }
  activeScan.percent =
    activeScan.total > 0
      ? Math.min(100, Math.round((current / activeScan.total) * 100))
      : 100;
  activeScan.statusText = `Probing ${current} of ${activeScan.total} files (${activeScan.percent}%)`;
}

export function completeScanProgress(summary: string, isBatchEnd = true): void {
  if (isBatchEnd) {
    activeScan = {
      ...activeScan,
      isScanning: false,
      phase: "complete",
      percent: 100,
      completedAt: new Date().toISOString(),
      lastSummary: summary,
      queueLength: 0,
    };
  } else {
    activeScan.lastSummary = summary;
  }
}

export function startWatcherScanProgress(totalLibraries = 1): void {
  activeScan = {
    isScanning: true,
    libraryName: "All Libraries (Watcher)",
    phase: "discovering",
    statusText: "Sweeping libraries for new or modified videos...",
    current: 0,
    total: 0,
    percent: 0,
    currentFile: "Checking disk modifications...",
    recommendedCount: 0,
    totalSavingsBytes: 0,
    startedAt: new Date().toISOString(),
    completedAt: undefined,
    queueLength: 0,
    activeLibraryIndex: 1,
    totalLibraries,
  };
}

export function completeWatcherScanProgress(newFiles: number, autoQueued: number): void {
  const summary =
    newFiles > 0
      ? `Watcher check complete: Discovered ${newFiles} new media file(s)${autoQueued > 0 ? ` and queued ${autoQueued} for optimization.` : "."}`
      : "Watcher check complete: All media libraries up-to-date.";
  activeScan = {
    ...activeScan,
    isScanning: false,
    phase: "complete",
    percent: 100,
    completedAt: new Date().toISOString(),
    lastSummary: summary,
    queueLength: 0,
  };
}
