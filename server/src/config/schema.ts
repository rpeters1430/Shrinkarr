import { z } from "zod";

export const LibrarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  mediaType: z.enum(["tv", "movie", "youtube", "web", "other"]).default("movie"),
  presetId: z.string().min(1).default("balanced"),
  autoOptimize: z.boolean().default(false),
});

export const HwAccelTypeSchema = z.enum([
  "auto",
  "amf",
  "qsv",
  "nvenc",
  "vaapi",
  "videotoolbox",
  "cpu",
]);

export const PresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  targetCodec: z.enum(["hevc", "h264", "av1"]).default("hevc"),
  targetContainer: z.enum(["mkv", "mp4"]).default("mkv"),
  crf: z.number().int().min(0).max(51).default(24),
  hwaccel: HwAccelTypeSchema.default("auto"),
  bitDepth: z.union([z.literal(8), z.literal(10)]).default(10),
  preserveHdr: z.boolean().default(true),
  audioMode: z.enum(["copy", "aac", "ac3"]).default("copy"),
  subtitleMode: z.enum(["copy", "drop"]).default("copy"),
  minSavingsPercent: z.number().min(0).max(100).default(20),
  minFileSizeMb: z.number().min(0).default(500),
  skipAlreadyTarget: z.boolean().default(true),
});

export const MediaServerIntegrationSchema = z.object({
  url: z.string().min(1),
  apiKey: z.string().min(1),
});

export const PlexIntegrationSchema = z.object({
  url: z.string().min(1),
  token: z.string().min(1),
  sectionId: z.string().min(1).optional(),
});

export const ArrIntegrationSchema = z.object({
  url: z.string().min(1),
  apiKey: z.string().min(1),
});

export const IntegrationsSchema = z.object({
  jellyfin: MediaServerIntegrationSchema.optional(),
  emby: MediaServerIntegrationSchema.optional(),
  plex: PlexIntegrationSchema.optional(),
  sonarr: ArrIntegrationSchema.optional(),
  radarr: ArrIntegrationSchema.optional(),
});

export const QueueSchema = z.object({
  concurrency: z.number().int().min(1).max(16).default(1),
  tempSuffix: z.string().min(1).default(".shrinkarr.tmp"),
  recycleBinPath: z.string().optional(),
  pauseOnStreaming: z.boolean().default(false),
  minFreeSpaceGb: z.number().min(0).default(10),
  fileLockRetryAttempts: z.number().int().min(1).max(20).default(6),
  fileLockRetryDelaySeconds: z.number().int().min(1).max(60).default(5),
  fileStabilityDelaySeconds: z.number().int().min(2).max(300).default(15),
});

export const WatcherSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMinutes: z.number().int().min(1).max(1440).default(15),
  autoOptimize: z.boolean().default(false),
  settleDelaySeconds: z.number().int().min(2).max(600).default(15),
});

export const DEFAULT_PRESETS: z.infer<typeof PresetSchema>[] = [
  {
    id: "balanced",
    name: "Balanced (HEVC 10-bit)",
    targetCodec: "hevc",
    targetContainer: "mkv",
    crf: 24,
    hwaccel: "auto",
    bitDepth: 10,
    preserveHdr: true,
    audioMode: "copy",
    subtitleMode: "copy",
    minSavingsPercent: 20,
    minFileSizeMb: 500,
    skipAlreadyTarget: true,
  },
  {
    id: "max-savings",
    name: "Maximum Savings (AV1 10-bit)",
    targetCodec: "av1",
    targetContainer: "mkv",
    crf: 28,
    hwaccel: "auto",
    bitDepth: 10,
    preserveHdr: true,
    audioMode: "aac",
    subtitleMode: "copy",
    minSavingsPercent: 30,
    minFileSizeMb: 500,
    skipAlreadyTarget: true,
  },
  {
    id: "web-youtube",
    name: "YouTube & Web Videos (HEVC MP4)",
    targetCodec: "hevc",
    targetContainer: "mp4",
    crf: 24,
    hwaccel: "auto",
    bitDepth: 8,
    preserveHdr: true,
    audioMode: "aac",
    subtitleMode: "copy",
    minSavingsPercent: 15,
    minFileSizeMb: 50,
    skipAlreadyTarget: true,
  },
  {
    id: "jellyfin-compat",
    name: "Jellyfin Direct-Play Compatible",
    targetCodec: "hevc",
    targetContainer: "mp4",
    crf: 23,
    hwaccel: "auto",
    bitDepth: 8,
    preserveHdr: true,
    audioMode: "aac",
    subtitleMode: "copy",
    minSavingsPercent: 15,
    minFileSizeMb: 300,
    skipAlreadyTarget: true,
  },
  {
    id: "keep-quality",
    name: "High Quality (HEVC Main10)",
    targetCodec: "hevc",
    targetContainer: "mkv",
    crf: 20,
    hwaccel: "auto",
    bitDepth: 10,
    preserveHdr: true,
    audioMode: "copy",
    subtitleMode: "copy",
    minSavingsPercent: 25,
    minFileSizeMb: 1000,
    skipAlreadyTarget: true,
  },
];

export const ConfigSchema = z.object({
  libraries: z.array(LibrarySchema).default([]),
  presets: z.array(PresetSchema).default(DEFAULT_PRESETS),
  integrations: IntegrationsSchema.default({}),
  queue: QueueSchema.default({
    concurrency: 1,
    tempSuffix: ".shrinkarr.tmp",
    pauseOnStreaming: false,
    minFreeSpaceGb: 10,
    fileLockRetryAttempts: 6,
    fileLockRetryDelaySeconds: 5,
    fileStabilityDelaySeconds: 15,
  }),
  watcher: WatcherSchema.default({
    enabled: true,
    intervalMinutes: 15,
    autoOptimize: false,
    settleDelaySeconds: 15,
  }),
  dbPath: z.string().min(1).default("data/shrinkarr.db"),
  preferredHwAccel: HwAccelTypeSchema.default("auto"),
  apiKey: z.string().min(16).optional(),
});

export type HwAccelType = z.infer<typeof HwAccelTypeSchema>;
export type Library = z.infer<typeof LibrarySchema>;
export type Preset = z.infer<typeof PresetSchema>;
export type Integrations = z.infer<typeof IntegrationsSchema>;
export type Queue = z.infer<typeof QueueSchema>;
export type Watcher = z.infer<typeof WatcherSchema>;
export type Config = z.infer<typeof ConfigSchema>;
