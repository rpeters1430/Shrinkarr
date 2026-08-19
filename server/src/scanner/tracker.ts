export interface ScanProgress {
  isScanning: boolean;
  libraryId?: string;
  libraryName?: string;
  current: number;
  total: number;
  percent: number;
  currentFile?: string;
  recommendedCount: number;
  startedAt?: string;
  completedAt?: string;
  lastSummary?: string;
}

let activeScan: ScanProgress = {
  isScanning: false,
  current: 0,
  total: 0,
  percent: 0,
  recommendedCount: 0,
};

export function getScanProgress(): ScanProgress {
  return activeScan;
}

export function startScanProgress(libraryId: string, libraryName: string, total: number): void {
  activeScan = {
    isScanning: true,
    libraryId,
    libraryName,
    current: 0,
    total,
    percent: total === 0 ? 100 : 0,
    currentFile: "",
    recommendedCount: 0,
    startedAt: new Date().toISOString(),
  };
}

export function updateScanStep(current: number, currentFile: string, isRecommended: boolean): void {
  if (!activeScan.isScanning) return;
  activeScan.current = current;
  activeScan.currentFile = currentFile;
  if (isRecommended) {
    activeScan.recommendedCount += 1;
  }
  activeScan.percent = activeScan.total > 0
    ? Math.min(100, Math.round((current / activeScan.total) * 100))
    : 100;
}

export function completeScanProgress(summary: string): void {
  activeScan = {
    ...activeScan,
    isScanning: false,
    percent: 100,
    completedAt: new Date().toISOString(),
    lastSummary: summary,
  };
}
