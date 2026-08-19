import { z } from "zod";

export const LibrarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  mediaType: z.enum(["tv", "movie", "other"]),
  presetId: z.string().min(1),
});

export const PresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  targetCodec: z.enum(["hevc", "h264"]),
  targetContainer: z.enum(["mkv", "mp4"]),
  crf: z.number().int().min(0).max(51),
  hwaccel: z.enum(["vaapi", "cpu"]),
  minSavingsPercent: z.number().min(0).max(100),
});

export const MediaServerIntegrationSchema = z.object({
  url: z.string().url(),
  apiKey: z.string().min(1),
});

export const PlexIntegrationSchema = z.object({
  url: z.string().url(),
  token: z.string().min(1),
  sectionId: z.string().min(1),
});

export const ArrIntegrationSchema = z.object({
  url: z.string().url(),
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
});

export const ConfigSchema = z.object({
  libraries: z.array(LibrarySchema).min(1),
  presets: z.array(PresetSchema).min(1),
  integrations: IntegrationsSchema.default({}),
  queue: QueueSchema.default({ concurrency: 1, tempSuffix: ".shrinkarr.tmp" }),
  dbPath: z.string().min(1).default("data/shrinkarr.db"),
});

export type Library = z.infer<typeof LibrarySchema>;
export type Preset = z.infer<typeof PresetSchema>;
export type Integrations = z.infer<typeof IntegrationsSchema>;
export type Queue = z.infer<typeof QueueSchema>;
export type Config = z.infer<typeof ConfigSchema>;
