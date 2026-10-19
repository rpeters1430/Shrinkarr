import { z } from "zod";

const StringRuleConditionSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("videoCodec"), operator: z.enum(["equals", "oneOf", "contains"]), value: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]) }),
  z.object({ field: z.literal("audioCodec"), operator: z.enum(["equals", "oneOf", "contains"]), value: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]) }),
  z.object({ field: z.literal("container"), operator: z.enum(["equals", "oneOf", "contains"]), value: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]) }),
  z.object({ field: z.literal("path"), operator: z.enum(["equals", "oneOf", "contains", "glob"]), value: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]) }),
]);

const NumericRuleConditionSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("sizeBytes"), operator: z.enum(["equals", "oneOf", "greaterThan", "lessThan", "between"]), value: z.union([z.number().finite().nonnegative(), z.array(z.number().finite().nonnegative()).min(1), z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()])]) }),
  z.object({ field: z.literal("durationSeconds"), operator: z.enum(["equals", "oneOf", "greaterThan", "lessThan", "between"]), value: z.union([z.number().finite().nonnegative(), z.array(z.number().finite().nonnegative()).min(1), z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()])]) }),
  z.object({ field: z.literal("width"), operator: z.enum(["equals", "oneOf", "greaterThan", "lessThan", "between"]), value: z.union([z.number().int().nonnegative(), z.array(z.number().int().nonnegative()).min(1), z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])]) }),
  z.object({ field: z.literal("height"), operator: z.enum(["equals", "oneOf", "greaterThan", "lessThan", "between"]), value: z.union([z.number().int().nonnegative(), z.array(z.number().int().nonnegative()).min(1), z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])]) }),
  z.object({ field: z.literal("bitrateKbps"), operator: z.enum(["equals", "oneOf", "greaterThan", "lessThan", "between"]), value: z.union([z.number().finite().nonnegative(), z.array(z.number().finite().nonnegative()).min(1), z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()])]) }),
  z.object({ field: z.literal("bitDepth"), operator: z.enum(["equals", "oneOf", "greaterThan", "lessThan", "between"]), value: z.union([z.number().int().positive(), z.array(z.number().int().positive()).min(1), z.tuple([z.number().int().positive(), z.number().int().positive()])]) }),
  z.object({ field: z.literal("audioChannels"), operator: z.enum(["equals", "oneOf", "greaterThan", "lessThan", "between"]), value: z.union([z.number().int().nonnegative(), z.array(z.number().int().nonnegative()).min(1), z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])]) }),
  z.object({ field: z.literal("subtitleCount"), operator: z.enum(["equals", "oneOf", "greaterThan", "lessThan", "between"]), value: z.union([z.number().int().nonnegative(), z.array(z.number().int().nonnegative()).min(1), z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])]) }),
]);

export const RuleConditionSchema = z.union([
  StringRuleConditionSchema,
  NumericRuleConditionSchema,
  z.object({ field: z.literal("mediaKind"), operator: z.enum(["equals", "oneOf"]), value: z.union([z.enum(["video", "audio"]), z.array(z.enum(["video", "audio"])).min(1)]) }),
  z.object({ field: z.literal("isHdr"), operator: z.literal("equals"), value: z.boolean() }),
]).superRefine((condition, ctx) => {
  if (condition.operator === "between" && Array.isArray(condition.value) && condition.value.length === 2 && condition.value[0] > condition.value[1]) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "The lower bound must not exceed the upper bound" });
  }
  if (condition.operator === "oneOf" && !Array.isArray(condition.value)) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "oneOf requires a list of values" });
  }
  if (condition.operator !== "oneOf" && Array.isArray(condition.value) && condition.operator !== "between") {
    ctx.addIssue({ code: "custom", path: ["value"], message: `${condition.operator} requires a single value` });
  }
  if (condition.operator === "between" && (!Array.isArray(condition.value) || condition.value.length !== 2)) {
    ctx.addIssue({ code: "custom", path: ["value"], message: "between requires exactly two values" });
  }
});

export const LibraryRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  conditions: z.array(RuleConditionSchema).min(1).max(16),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("preset"), presetId: z.string().min(1) }),
    z.object({ type: z.literal("keep") }),
  ]),
});

export const LibrarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  mediaType: z.enum(["tv", "movie", "youtube", "web", "music", "other"]).default("movie"),
  presetId: z.string().min(1).default("balanced"),
  autoOptimize: z.boolean().default(false),
  minFileSizeMb: z.number().min(0).optional(),
  // Paths to leave out of scans, relative to the library folder. A bare name
  // such as "Extras" or "*sample*" matches a file or folder at any depth;
  // anything containing "/" is used as a glob as-is.
  excludePatterns: z.preprocess(
    (value) => (Array.isArray(value)
      ? value.filter((p) => typeof p === "string" && p.trim()).map((p: string) => p.trim())
      : value),
    z.array(z.string().min(1)),
  ).default([]),
  rules: z.array(LibraryRuleSchema).max(100).default([]),
}).superRefine((library, ctx) => {
  const ids = new Set<string>();
  library.rules.forEach((rule, index) => {
    if (ids.has(rule.id)) {
      ctx.addIssue({ code: "custom", path: ["rules", index, "id"], message: `Duplicate rule ID: ${rule.id}` });
    }
    ids.add(rule.id);
  });
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
  // "video" presets drive the existing FFmpeg video-transcode pipeline; "audio"
  // presets drive the music-transcode pipeline below and ignore the video-only
  // fields (targetCodec, crf, hwaccel, bitDepth, preserveHdr, subtitleMode).
  mediaKind: z.enum(["video", "audio"]).default("video"),
  targetCodec: z.enum(["hevc", "h264", "av1"]).default("hevc"),
  targetContainer: z.enum(["mkv", "mp4"]).default("mkv"),
  crf: z.number().int().min(0).max(51).default(24),
  hwaccel: HwAccelTypeSchema.default("auto"),
  bitDepth: z.union([z.literal(8), z.literal(10)]).default(10),
  preserveHdr: z.boolean().default(true),
  audioMode: z.enum(["copy", "aac", "ac3", "smart"]).default("copy"),
  subtitleMode: z.enum(["copy", "drop"]).default("copy"),
  // Audio-preset-only fields (see mediaKind above).
  targetAudioCodec: z.enum(["opus", "aac", "mp3", "flac"]).default("opus"),
  targetAudioBitrateKbps: z.number().int().min(32).max(960).default(160),
  // When true (the default), only lossless sources (FLAC/ALAC/WAV/...) are
  // transcoded. Re-encoding an already-lossy file (mp3/aac/opus) is a
  // destructive quality trade for little space savings, so it stays opt-in.
  onlyIfLosslessSource: z.boolean().default(true),
  minSavingsPercent: z.number().min(0).max(100).default(20),
  minFileSizeMb: z.number().min(0).default(500),
  skipAlreadyTarget: z.boolean().default(true),
  // Language codes ("eng", "en", "jpn"...) of the audio and subtitle tracks to
  // keep. Empty keeps every track. Tracks with no language tag are always kept,
  // and if no audio track matches, all audio is kept rather than none.
  keepAudioLanguages: z.array(z.string().min(1)).default([]),
  keepSubtitleLanguages: z.array(z.string().min(1)).default([]),
  // Adds an AAC 2.0 downmix when every kept audio track is surround, so
  // TVs and phones can direct-play without the media server transcoding audio.
  addStereoAudio: z.boolean().default(false),
  // Videos larger than this are scaled down (aspect ratio kept). "none" never scales.
  maxResolution: z.enum(["none", "2160p", "1440p", "1080p", "720p", "480p"]).default("none"),
  // Rewrites legacy containers (AVI, WMV, FLV, MPEG-TS...) into targetContainer
  // and applies the track cleanup above without re-encoding the video.
  remuxWhenVideoIsFine: z.boolean().default(true),
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

export const ScheduleWindowSchema = z.object({
  // Identifies a single window; a day may have several, so `day` alone is not unique.
  id: z.string().optional(),
  day: z.number().int().min(0).max(6),
  enabled: z.boolean().default(true),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm format"),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:mm format"),
});

export const QueueScheduleSchema = z.object({
  enabled: z.boolean().default(false),
  // Legacy daily window fields remain supported for existing config files.
  startHour: z.number().int().min(0).max(23).default(1),
  endHour: z.number().int().min(0).max(23).default(7),
  // Multiple windows per day are allowed (e.g. a morning and an evening window),
  // capped at 8 per day (56 total) so the UI stays usable.
  windows: z
    .array(ScheduleWindowSchema)
    .max(56)
    .refine(
      (windows) => {
        const perDay = new Map<number, number>();
        for (const window of windows) perDay.set(window.day, (perDay.get(window.day) ?? 0) + 1);
        return [...perDay.values()].every((count) => count <= 8);
      },
      { message: "A single day cannot have more than 8 windows" },
    )
    .optional(),
  timezone: z.string().optional(),
  stopActiveOnExit: z.boolean().default(true),
});

export const QueueSchema = z.object({
  concurrency: z.number().int().min(1).max(16).default(1),
  order: z.enum(["savings", "oldest"]).default("savings"),
  tempSuffix: z.string().min(1).default(".shrinkarr.tmp"),
  tempDirectory: z.string().optional(),
  recycleBinPath: z.string().optional(),
  pauseOnStreaming: z.boolean().default(false),
  lowPriority: z.boolean().default(true),
  threads: z.number().int().min(0).max(64).default(0),
  schedule: QueueScheduleSchema.optional(),
  minFreeSpaceGb: z.number().min(0).default(10),
  fileLockRetryAttempts: z.number().int().min(1).max(20).default(6),
  fileLockRetryDelaySeconds: z.number().int().min(1).max(60).default(5),
  fileStabilityDelaySeconds: z.number().int().min(2).max(300).default(15),
  // Decode check run on the source before each transcode. "quick" decodes
  // three short samples; "thorough" decodes the whole file.
  healthCheck: z.enum(["off", "quick", "thorough"]).default("quick"),
  // Health check jobs run in their own pool so a library-wide check doesn't
  // hold up transcodes.
  healthCheckConcurrency: z.number().int().min(1).max(8).default(1),
  // A full-frame SSIM comparison adds another decode pass, so this quality
  // gate stays disabled unless the user explicitly opts in.
  qualityGate: z.object({
    enabled: z.boolean().default(false),
    minimumSsim: z.number().finite().min(0).max(1).default(0.95),
  }).default({ enabled: false, minimumSsim: 0.95 }),
});

export const WatcherSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMinutes: z.number().int().min(1).max(1440).default(15),
  // Also react to filesystem events between sweeps. Network mounts often
  // deliver none, so the interval sweep keeps running either way.
  events: z.boolean().default(true),
  autoOptimize: z.boolean().default(false),
  settleDelaySeconds: z.number().int().min(2).max(600).default(15),
});

export const WebhooksSchema = z.object({
  // Rewrites Sonarr/Radarr paths into Shrinkarr's when the two mount the
  // same storage at different places, e.g. { from: "/tv", to: "/media/tv" }.
  pathMappings: z.preprocess(
    // The Settings form saves rows the user hasn't finished filling in.
    (value) => (Array.isArray(value)
      ? value.filter((m) => typeof m?.from === "string" && m.from.trim() && typeof m?.to === "string" && m.to.trim())
      : value),
    z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })),
  ).default([]),
});

// Where to send alerts about finished jobs. Every target is optional; blank
// strings from the Settings form count as unset.
export const NotificationsSchema = z.object({
  discordWebhookUrl: z.string().optional(),
  // Full topic URL, e.g. https://ntfy.sh/my-shrinkarr-topic
  ntfyUrl: z.string().optional(),
  ntfyToken: z.string().optional(),
  // Receives a JSON POST: { event, title, message, job? }
  webhookUrl: z.string().optional(),
  onJobDone: z.boolean().default(false),
  onJobFailed: z.boolean().default(true),
  onQueueEmpty: z.boolean().default(true),
});

export const ScannerSchema = z.object({
  // Number of ffprobe processes run in parallel while indexing a library.
  probeConcurrency: z.number().int().min(1).max(32).default(4),
});

export const AuthSchema = z.object({
  username: z.string().min(1),
  passwordHash: z.string().min(1),
  sessionSecret: z.string().min(32),
});

type PresetOutput = z.infer<typeof PresetSchema>;
type StreamDefaults = Pick<PresetOutput, "keepAudioLanguages" | "keepSubtitleLanguages" | "addStereoAudio" | "maxResolution" | "remuxWhenVideoIsFine">;

const STREAM_DEFAULTS: StreamDefaults = {
  keepAudioLanguages: [],
  keepSubtitleLanguages: [],
  addStereoAudio: false,
  maxResolution: "none",
  remuxWhenVideoIsFine: true,
};

const BASE_PRESETS: Omit<PresetOutput, keyof StreamDefaults>[] = [
  {
    id: "balanced",
    name: "Balanced (HEVC 10-bit)",
    mediaKind: "video",
    targetAudioCodec: "opus",
    targetAudioBitrateKbps: 160,
    onlyIfLosslessSource: true,
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
    mediaKind: "video",
    targetAudioCodec: "opus",
    targetAudioBitrateKbps: 160,
    onlyIfLosslessSource: true,
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
    mediaKind: "video",
    targetAudioCodec: "opus",
    targetAudioBitrateKbps: 160,
    onlyIfLosslessSource: true,
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
    mediaKind: "video",
    targetAudioCodec: "opus",
    targetAudioBitrateKbps: 160,
    onlyIfLosslessSource: true,
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
    id: "emby-compat",
    name: "Emby Direct-Play Compatible",
    mediaKind: "video",
    targetAudioCodec: "opus",
    targetAudioBitrateKbps: 160,
    onlyIfLosslessSource: true,
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
    id: "plex-compat",
    name: "Plex & Universal Compatibility (H.264 MP4)",
    mediaKind: "video",
    targetAudioCodec: "opus",
    targetAudioBitrateKbps: 160,
    onlyIfLosslessSource: true,
    targetCodec: "h264",
    targetContainer: "mp4",
    crf: 22,
    hwaccel: "auto",
    bitDepth: 8,
    preserveHdr: false,
    audioMode: "aac",
    subtitleMode: "copy",
    minSavingsPercent: 15,
    minFileSizeMb: 300,
    skipAlreadyTarget: true,
  },
  {
    id: "keep-quality",
    name: "High Quality (HEVC Main10)",
    mediaKind: "video",
    targetAudioCodec: "opus",
    targetAudioBitrateKbps: 160,
    onlyIfLosslessSource: true,
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
  {
    id: "anime-animation",
    name: "Anime & 2D Animation (HEVC 10-bit)",
    mediaKind: "video",
    targetAudioCodec: "opus",
    targetAudioBitrateKbps: 160,
    onlyIfLosslessSource: true,
    targetCodec: "hevc",
    targetContainer: "mkv",
    crf: 22,
    hwaccel: "auto",
    bitDepth: 10,
    preserveHdr: true,
    audioMode: "copy",
    subtitleMode: "copy",
    minSavingsPercent: 20,
    minFileSizeMb: 300,
    skipAlreadyTarget: true,
  },
  {
    id: "4k-hdr-preservation",
    name: "4K UHD HDR Preservation (HEVC 10-bit)",
    mediaKind: "video",
    targetAudioCodec: "opus",
    targetAudioBitrateKbps: 160,
    onlyIfLosslessSource: true,
    targetCodec: "hevc",
    targetContainer: "mkv",
    crf: 22,
    hwaccel: "auto",
    bitDepth: 10,
    preserveHdr: true,
    audioMode: "copy",
    subtitleMode: "copy",
    minSavingsPercent: 20,
    minFileSizeMb: 2000,
    skipAlreadyTarget: true,
  },
  {
    id: "music-space-saver",
    name: "Music: Space Saver (Opus 160k)",
    mediaKind: "audio",
    targetCodec: "hevc",
    targetContainer: "mkv",
    crf: 24,
    hwaccel: "auto",
    bitDepth: 10,
    preserveHdr: true,
    audioMode: "copy",
    subtitleMode: "copy",
    targetAudioCodec: "opus",
    targetAudioBitrateKbps: 160,
    onlyIfLosslessSource: true,
    minSavingsPercent: 30,
    minFileSizeMb: 5,
    skipAlreadyTarget: true,
  },
  {
    id: "music-max-compat",
    name: "Music: Max Compatibility (AAC 256k)",
    mediaKind: "audio",
    targetCodec: "hevc",
    targetContainer: "mkv",
    crf: 24,
    hwaccel: "auto",
    bitDepth: 10,
    preserveHdr: true,
    audioMode: "copy",
    subtitleMode: "copy",
    targetAudioCodec: "aac",
    targetAudioBitrateKbps: 256,
    onlyIfLosslessSource: true,
    minSavingsPercent: 20,
    minFileSizeMb: 5,
    skipAlreadyTarget: true,
  },
];

export const DEFAULT_PRESETS: PresetOutput[] = BASE_PRESETS.map((preset) => ({ ...STREAM_DEFAULTS, ...preset }));

export const ConfigSchema = z.object({
  libraries: z.array(LibrarySchema).default([]),
  presets: z.array(PresetSchema).default(DEFAULT_PRESETS),
  integrations: IntegrationsSchema.default({}),
  queue: QueueSchema.default({
    concurrency: 1,
    order: "savings",
    tempSuffix: ".shrinkarr.tmp",
    pauseOnStreaming: false,
    lowPriority: true,
    threads: 0,
    minFreeSpaceGb: 10,
    fileLockRetryAttempts: 6,
    fileLockRetryDelaySeconds: 5,
    fileStabilityDelaySeconds: 15,
    healthCheck: "quick",
    healthCheckConcurrency: 1,
    qualityGate: { enabled: false, minimumSsim: 0.95 },
  }),
  watcher: WatcherSchema.default({
    enabled: true,
    intervalMinutes: 15,
    events: true,
    autoOptimize: false,
    settleDelaySeconds: 15,
  }),
  scanner: ScannerSchema.default({ probeConcurrency: 4 }),
  webhooks: WebhooksSchema.default({ pathMappings: [] }),
  notifications: NotificationsSchema.default({ onJobDone: false, onJobFailed: true, onQueueEmpty: true }),
  dbPath: z.string().min(1).default("data/shrinkarr.db"),
  preferredHwAccel: HwAccelTypeSchema.default("auto"),
  auth: AuthSchema.optional(),
}).superRefine((config, ctx) => {
  const presets = new Map(config.presets.map((preset) => [preset.id, preset]));
  config.libraries.forEach((library, libraryIndex) => {
    const libraryPreset = presets.get(library.presetId) ?? config.presets[0];
    const scanKind = libraryPreset?.mediaKind;
    library.rules.forEach((rule, ruleIndex) => {
      const mediaKindCondition = rule.conditions.find((condition) => condition.field === "mediaKind");
      const kinds = mediaKindCondition ? (Array.isArray(mediaKindCondition.value) ? mediaKindCondition.value : [mediaKindCondition.value]) : [];
      if (scanKind && mediaKindCondition && !kinds.includes(scanKind)) {
        ctx.addIssue({ code: "custom", path: ["libraries", libraryIndex, "rules", ruleIndex, "conditions"], message: `Library ${library.id} scans ${scanKind} media; rule conditions cannot target other media kinds` });
      }
      if (rule.action.type === "preset") {
        const preset = presets.get(rule.action.presetId);
        if (!preset) {
          ctx.addIssue({ code: "custom", path: ["libraries", libraryIndex, "rules", ruleIndex, "action", "presetId"], message: `Unknown preset: ${rule.action.presetId}` });
          return;
        }
        if (!kinds.includes(preset.mediaKind)) {
          ctx.addIssue({ code: "custom", path: ["libraries", libraryIndex, "rules", ruleIndex, "conditions"], message: `Preset ${preset.id} requires a mediaKind condition compatible with ${preset.mediaKind}` });
        }
        if (scanKind && preset.mediaKind !== scanKind) {
          ctx.addIssue({ code: "custom", path: ["libraries", libraryIndex, "rules", ruleIndex, "action", "presetId"], message: `Preset ${preset.id} is ${preset.mediaKind}, but library ${library.id} scans ${scanKind} media` });
        }
      }
    });
  });
});

export type HwAccelType = z.infer<typeof HwAccelTypeSchema>;
export type Library = z.infer<typeof LibrarySchema>;
export type LibraryRule = z.infer<typeof LibraryRuleSchema>;
export type RuleCondition = z.infer<typeof RuleConditionSchema>;
export type Preset = z.infer<typeof PresetSchema>;
export type Integrations = z.infer<typeof IntegrationsSchema>;
export type Queue = z.infer<typeof QueueSchema>;
export type Watcher = z.infer<typeof WatcherSchema>;
export type Scanner = z.infer<typeof ScannerSchema>;
export type Webhooks = z.infer<typeof WebhooksSchema>;
export type Notifications = z.infer<typeof NotificationsSchema>;
export type Auth = z.infer<typeof AuthSchema>;
export type Config = z.infer<typeof ConfigSchema>;
