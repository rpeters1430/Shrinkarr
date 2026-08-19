export interface Library {
  id: string;
  name: string;
  path: string;
  mediaType: "tv" | "movie" | "other";
  presetId: string;
}

export interface Preset {
  id: string;
  name: string;
  targetCodec: "hevc" | "h264";
  targetContainer: "mkv" | "mp4";
  crf: number;
  hwaccel: "vaapi" | "cpu";
  minSavingsPercent: number;
}

export type JobStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  filePath: string;
  presetId: string;
  status: JobStatus;
  progressPercent: number;
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
  lastScannedAt: string;
  needsTranscode: boolean;
  skipReason: string | null;
}

export interface Stats {
  filesScanned: number;
  jobsByStatus: Record<string, number>;
  spaceSavedBytes: number;
  transcodedCount: number;
}

export interface Config {
  libraries: Library[];
  presets: Preset[];
  integrations: Record<string, unknown>;
  queue: { concurrency: number; tempSuffix: string };
  dbPath: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export const getStats = () => request<Stats>("/stats");
export const getJobs = (status?: JobStatus) =>
  request<Job[]>(`/jobs${status ? `?status=${status}` : ""}`);
export const getLibraries = () => request<Library[]>("/libraries");
export const getLibraryFiles = (libraryId: string) =>
  request<FileRecord[]>(`/libraries/${libraryId}/files`);
export const getConfig = () => request<Config>("/config");
export const putConfig = (config: Config) =>
  request<Config>("/config", { method: "PUT", body: JSON.stringify(config) });
export const postScan = (libraryId: string) =>
  request<{ status: string }>(`/libraries/${libraryId}/scan`, { method: "POST" });
export const postCancelJob = (jobId: string) =>
  request<Job>(`/jobs/${jobId}/cancel`, { method: "POST" });
export const postJob = (filePath: string, presetId: string) =>
  request<Job>("/jobs", { method: "POST", body: JSON.stringify({ filePath, presetId }) });
