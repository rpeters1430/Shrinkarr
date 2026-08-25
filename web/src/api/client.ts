import { clearApiKey, getApiKey } from "../auth";

export const UNAUTHORIZED_EVENT = "shrinkarr:unauthorized";

export interface Library {
  id: string;
  name: string;
  path: string;
  mediaType: "tv" | "movie" | "youtube" | "web" | "other";
  presetId: string;
  autoOptimize?: boolean;
}

export type HwAccelType = "auto" | "amf" | "qsv" | "nvenc" | "vaapi" | "videotoolbox" | "cpu";

export interface Preset {
  id: string;
  name: string;
  targetCodec: "hevc" | "av1" | "h264";
  targetContainer: "mkv" | "mp4";
  crf: number;
  hwaccel: HwAccelType;
  bitDepth?: 8 | 10;
  preserveHdr?: boolean;
  audioMode?: "copy" | "aac" | "ac3";
  subtitleMode?: "copy" | "drop";
  minSavingsPercent: number;
  minFileSizeMb?: number;
  skipAlreadyTarget?: boolean;
}

export type JobStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  filePath: string;
  presetId: string;
  status: JobStatus;
  progressPercent: number;
  fps: number;
  speed: string;
  encoderUsed: string | null;
  error: string | null;
  originalSizeBytes: number | null;
  newSizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileRecord {
  path: string;
  libraryId: string;
  codec: string;
  container: string;
  sizeBytes: number;
  durationSeconds: number;
  resolution: string;
  width: number;
  height: number;
  bitrateKbps: number;
  bitDepth: number;
  isHdr: boolean;
  audioCodec: string;
  audioChannels: number;
  subtitleCount: number;
  estimatedSavingsBytes: number;
  recommendedAction: string;
  lastScannedAt: string;
  needsTranscode: boolean;
  skipReason: string | null;
}

export interface LibrarySummary {
  id: string;
  name: string;
  path: string;
  mediaType: "tv" | "movie" | "youtube" | "web" | "other";
  presetId: string;
  fileCount: number;
  totalSizeBytes: number;
  potentialSavingsBytes: number;
  eligibleCount: number;
}

export interface Stats {
  filesScanned: number;
  totalLibrarySizeBytes: number;
  totalPotentialSavingsBytes: number;
  recommendedCount: number;
  spaceSavedBytes: number;
  transcodedCount: number;
  jobsByStatus: Record<string, number>;
  codecBreakdown: Record<string, { count: number; sizeBytes: number }>;
  resolutionBreakdown: Record<string, { count: number; sizeBytes: number }>;
  librarySummaries: LibrarySummary[];
}

export interface DetectedGpu {
  name: string;
  vendor: "nvidia" | "intel" | "amd" | "apple" | "other";
  driverVersion?: string;
}

export interface DetectedEncoder {
  id: string;
  name: string;
  codec: "hevc" | "av1" | "h264";
  hwaccelType: "amf" | "qsv" | "nvenc" | "vaapi" | "videotoolbox" | "cpu";
  working: boolean;
  speedMultiplier?: number;
  description: string;
}

export interface HardwareReport {
  os: string;
  platform: string;
  gpus: DetectedGpu[];
  encoders: DetectedEncoder[];
  recommendedHevc: string;
  recommendedAv1: string;
  recommendedH264: string;
  summary: string;
  testedAt: string;
}

export interface SimulationResult {
  filePath: string;
  sourceCodec: string;
  sourceResolution: string;
  originalSizeBytes: number;
  originalSampleSizeBytes: number;
  encodedSampleSizeBytes: number;
  sampleDurationSeconds: number;
  compressionRatio: number;
  measuredSavingsPercent: number;
  estimatedNewSizeBytes: number;
  estimatedSavingsBytes: number;
  encoderUsed: string;
  durationMs: number;
}

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DriveInfo {
  name: string;
  path: string;
  isNasOrNetwork?: boolean;
}

export interface BrowseResult {
  currentPath: string;
  parentPath: string;
  directories: DirectoryEntry[];
  availableDrives?: DriveInfo[];
  suggestedMediaFolders?: string[];
}

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

export interface WatcherStatus {
  enabled: boolean;
  isScanning: boolean;
  intervalMinutes: number;
  autoOptimize: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  newFilesFoundLastRun: number;
  autoOptimizedLastRun: number;
  totalNewFilesDiscovered: number;
  totalAutoOptimized: number;
}

export interface IntegrationsConfig {
  jellyfin?: { url: string; apiKey: string };
  emby?: { url: string; apiKey: string };
  plex?: { url: string; token: string; sectionId?: string };
  sonarr?: { url: string; apiKey: string };
  radarr?: { url: string; apiKey: string };
}

export interface Config {
  libraries: Library[];
  presets: Preset[];
  integrations: IntegrationsConfig;
  queue: {
    concurrency: number;
    tempSuffix: string;
    recycleBinPath?: string;
    pauseOnStreaming?: boolean;
    minFreeSpaceGb?: number;
    fileLockRetryAttempts?: number;
    fileLockRetryDelaySeconds?: number;
    fileStabilityDelaySeconds?: number;
  };
  watcher?: {
    enabled: boolean;
    intervalMinutes: number;
    autoOptimize: boolean;
    settleDelaySeconds: number;
  };
  dbPath: string;
  preferredHwAccel?: HwAccelType;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body) {
    headers["Content-Type"] = "application/json";
  }
  const apiKey = getApiKey();
  if (apiKey) {
    headers["X-Api-Key"] = apiKey;
  }
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...headers,
      ...((init?.headers as Record<string, string>) || {}),
    },
  });
  if (res.status === 401) {
    clearApiKey();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new Error("401 Unauthorized: API key missing or invalid");
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// Stats & Hardware
export const getStats = () => request<Stats>("/stats");
export const getHardware = (refresh = false) => request<HardwareReport>(`/hardware${refresh ? "?refresh=true" : ""}`);
export const testHardwareEncoder = (encoderId: string) =>
  request<{ encoderId: string; ok: boolean; speedMultiplier?: number }>("/hardware/test", {
    method: "POST",
    body: JSON.stringify({ encoderId }),
  });

// Libraries & Scanner & Watcher
export const getLibraries = () => request<Library[]>("/libraries");
export const getScanStatus = () => request<ScanProgress>("/scan/status");
export const getWatcherStatus = () => request<WatcherStatus>("/watcher/status");
export const triggerWatcherCheck = () =>
  request<{ newFiles: number; autoQueued: number }>("/watcher/check", { method: "POST" });
export const scanNewItems = () =>
  request<{ newFiles: number; autoQueued: number }>("/libraries/scan-new", { method: "POST" });
export const createLibrary = (lib: Library) =>
  request<Library>("/libraries", { method: "POST", body: JSON.stringify(lib) });
export const updateLibrary = (id: string, lib: Partial<Library>) =>
  request<Library>(`/libraries/${id}`, { method: "PUT", body: JSON.stringify(lib) });
export const deleteLibrary = (id: string) =>
  request<{ success: boolean; id: string }>(`/libraries/${id}`, { method: "DELETE" });
export const getLibraryFiles = (libraryId: string) =>
  request<FileRecord[]>(`/libraries/${libraryId}/files`);
export const postScan = (libraryId: string, autoQueue = false) =>
  request<{ status: string; libraryId: string }>(`/libraries/${libraryId}/scan`, {
    method: "POST",
    body: JSON.stringify({ autoQueue }),
  });
export const postOptimizeLibrary = (libraryId: string) =>
  request<{ libraryId: string; queued: number; totalEligible: number }>(`/libraries/${libraryId}/optimize`, {
    method: "POST",
  });

// Presets
export const getPresets = () => request<Preset[]>("/presets");
export const createPreset = (preset: Preset) =>
  request<Preset>("/presets", { method: "POST", body: JSON.stringify(preset) });
export const updatePreset = (id: string, preset: Partial<Preset>) =>
  request<Preset>(`/presets/${id}`, { method: "PUT", body: JSON.stringify(preset) });
export const deletePreset = (id: string) =>
  request<{ success: boolean; id: string }>(`/presets/${id}`, { method: "DELETE" });

// Jobs & Queue
export const getJobs = (status?: JobStatus) =>
  request<Job[]>(`/jobs${status ? `?status=${status}` : ""}`);
export const postJob = (filePath: string, presetId?: string) =>
  request<Job>("/jobs", { method: "POST", body: JSON.stringify({ filePath, presetId }) });
export const postCancelJob = (jobId: string) =>
  request<Job>(`/jobs/${jobId}/cancel`, { method: "POST" });
export const postCancelAllJobs = () =>
  request<{ cancelledCount: number }>("/jobs/cancel-all", { method: "POST" });
export const clearJobHistory = () =>
  request<{ clearedCount: number }>("/jobs/clear-history", { method: "POST" });
export const getQueueStatus = () =>
  request<{ paused: boolean; pending: number; running: number; done: number; failed: number; total: number }>("/queue/status");
export const pauseQueue = () => request<{ paused: boolean }>("/queue/pause", { method: "POST" });
export const resumeQueue = () => request<{ paused: boolean }>("/queue/resume", { method: "POST" });

// Simulation & System
export const postSimulate = (filePath: string, presetId?: string, sampleDurationSeconds = 30) =>
  request<SimulationResult>("/simulate", {
    method: "POST",
    body: JSON.stringify({ filePath, presetId, sampleDurationSeconds }),
  });
export const optimizeAll = () =>
  request<{ queued: number; totalEligible: number }>("/system/optimize-all", { method: "POST" });
export const browsePath = (path?: string) =>
  request<BrowseResult>(`/system/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`);

// Config & Integrations
export const getConfig = () => request<Config>("/config");
export const putConfig = (config: Partial<Config>) =>
  request<Config>("/config", { method: "PUT", body: JSON.stringify(config) });
export const testIntegration = async (
  service: "jellyfin" | "emby" | "plex" | "sonarr" | "radarr",
  url: string,
  tokenOrKey: string,
): Promise<{ success: boolean; message?: string; error?: string }> => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = getApiKey();
  if (apiKey) {
    headers["X-Api-Key"] = apiKey;
  }

  try {
    const res = await fetch("/api/integrations/test", {
      method: "POST",
      headers,
      body: JSON.stringify({ service, url, tokenOrKey }),
    });

    const data = (await res.json()) as { success?: boolean; message?: string; error?: string };
    if (res.ok && data.success) {
      return { success: true, message: data.message };
    }
    return { success: false, error: data.error || data.message || `HTTP ${res.status}: ${res.statusText}` };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
};
