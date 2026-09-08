import type { Library, Preset } from "../src/config/schema.js";
import type { FfprobeOutput, MediaProbe } from "../src/media/types.js";

/**
 * Deterministic pseudo-random generator so every benchmark run works on the
 * exact same data. Real randomness would make measurements non-reproducible.
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

export const BASE_PRESET: Preset = {
  id: "hevc-save-space",
  name: "H.265 to save space",
  targetCodec: "hevc",
  targetContainer: "mkv",
  crf: 24,
  hwaccel: "vaapi",
  bitDepth: 10,
  preserveHdr: true,
  audioMode: "copy",
  subtitleMode: "copy",
  minSavingsPercent: 15,
  minFileSizeMb: 500,
  skipAlreadyTarget: true,
};

/** One preset per hardware backend / target codec combination the app supports. */
export const PRESET_MATRIX: Preset[] = [
  BASE_PRESET,
  { ...BASE_PRESET, id: "hevc-cpu", hwaccel: "cpu", audioMode: "aac" },
  { ...BASE_PRESET, id: "hevc-amf", hwaccel: "amf" },
  { ...BASE_PRESET, id: "hevc-qsv", hwaccel: "qsv", bitDepth: 8 },
  { ...BASE_PRESET, id: "hevc-nvenc", hwaccel: "nvenc" },
  { ...BASE_PRESET, id: "av1-amf", targetCodec: "av1", hwaccel: "amf" },
  { ...BASE_PRESET, id: "av1-cpu", targetCodec: "av1", hwaccel: "cpu" },
  { ...BASE_PRESET, id: "av1-qsv", targetCodec: "av1", hwaccel: "qsv" },
  { ...BASE_PRESET, id: "h264-cpu", targetCodec: "h264", hwaccel: "cpu", subtitleMode: "drop" },
  { ...BASE_PRESET, id: "h264-nvenc", targetCodec: "h264", hwaccel: "nvenc" },
  {
    ...BASE_PRESET,
    id: "hevc-videotoolbox",
    hwaccel: "videotoolbox",
    targetContainer: "mp4",
    audioMode: "ac3",
  },
];

const CODECS = ["h264", "hevc", "av1", "mpeg2video", "vc1", "vp9", "wmv3", "msmpeg4v3"];
const RESOLUTIONS: MediaProbe["resolutionLabel"][] = ["4K", "1440p", "1080p", "720p", "480p", "SD"];
const AUDIO_CODECS = ["aac", "eac3", "dts", "truehd", "ac3", "flac"];

/** A library of probes spanning codecs, resolutions, bit depths and HDR flags. */
export function makeProbes(count: number, seed = 1337): MediaProbe[] {
  const rng = createRng(seed);
  const probes: MediaProbe[] = [];
  for (let i = 0; i < count; i += 1) {
    const resolutionLabel = RESOLUTIONS[i % RESOLUTIONS.length];
    const isHdr = i % 7 === 0;
    probes.push({
      durationSeconds: 600 + Math.round(rng() * 7800),
      sizeBytes: Math.round((20 + rng() * 60_000) * 1024 * 1024),
      videoCodec: CODECS[i % CODECS.length],
      container: i % 3 === 0 ? "mov" : "matroska",
      width: resolutionLabel === "4K" ? 3840 : 1920,
      height: resolutionLabel === "4K" ? 2160 : 1080,
      resolutionLabel,
      bitrateKbps: 1200 + Math.round(rng() * 60_000),
      bitDepth: isHdr ? 10 : 8,
      isHdr,
      colorTransfer: isHdr ? "smpte2084" : "bt709",
      fps: i % 4 === 0 ? 23.98 : 29.97,
      audioCodec: AUDIO_CODECS[i % AUDIO_CODECS.length],
      audioChannels: i % 5 === 0 ? 8 : 6,
      subtitleCount: i % 11,
    });
  }
  return probes;
}

/** Raw ffprobe payloads shaped like what the real binary emits for movie files. */
export function makeFfprobeOutputs(count: number, seed = 4242): FfprobeOutput[] {
  const rng = createRng(seed);
  const outputs: FfprobeOutput[] = [];
  for (let i = 0; i < count; i += 1) {
    const is4k = i % 3 === 0;
    const isHdr = is4k && i % 6 === 0;
    const subtitleCount = i % 5;
    const audioCount = 1 + (i % 3);

    const streams: FfprobeOutput["streams"] = [
      {
        codec_type: "video",
        codec_name: CODECS[i % CODECS.length],
        profile: isHdr ? "Main 10" : "High",
        width: is4k ? 3840 : 1920,
        height: is4k ? 2160 : 1080,
        pix_fmt: isHdr ? "yuv420p10le" : "yuv420p",
        bits_per_raw_sample: isHdr ? "10" : "8",
        color_transfer: isHdr ? "smpte2084" : "bt709",
        r_frame_rate: "24000/1001",
        avg_frame_rate: "24000/1001",
        bit_rate: String(4_000_000 + Math.round(rng() * 60_000_000)),
      },
    ];
    for (let a = 0; a < audioCount; a += 1) {
      streams.push({
        codec_type: "audio",
        codec_name: AUDIO_CODECS[(i + a) % AUDIO_CODECS.length],
        channels: a === 0 ? 6 : 2,
      });
    }
    for (let s = 0; s < subtitleCount; s += 1) {
      streams.push({
        codec_type: "subtitle",
        codec_name: s % 2 === 0 ? "subrip" : "hdmv_pgs_subtitle",
      });
    }

    outputs.push({
      streams,
      format: {
        duration: (1200 + rng() * 6000).toFixed(6),
        size: String(Math.round((500 + rng() * 60_000) * 1024 * 1024)),
        bit_rate: String(3_000_000 + Math.round(rng() * 60_000_000)),
        format_name: "matroska,webm",
      },
    });
  }
  return outputs;
}

export function makeLibraries(count: number): Library[] {
  const libraries: Library[] = [];
  for (let i = 0; i < count; i += 1) {
    libraries.push({
      id: `library-${i}`,
      name: `Library ${i}`,
      path: `/media/library-${i}/videos`,
      mediaType: i % 2 === 0 ? "movie" : "tv",
      presetId: BASE_PRESET.id,
      autoOptimize: i % 3 === 0,
    });
  }
  return libraries;
}

/** Mix of paths inside libraries, deep inside libraries, and outside of them. */
export function makeCandidatePaths(count: number, libraryCount: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i % 4 === 3) {
      paths.push(`/mnt/downloads/incomplete/show-${i}/episode-${i}.mkv`);
    } else {
      const lib = i % libraryCount;
      paths.push(`/media/library-${lib}/videos/Show ${i % 40}/Season ${i % 9}/episode-${i}.mkv`);
    }
  }
  return paths;
}
