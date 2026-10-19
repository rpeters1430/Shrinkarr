import type { Preset } from "../config/schema.js";
import type { AudioTrack, MediaProbe, SubtitleTrack } from "../media/types.js";

// Files tag languages with ISO 639-2 codes, in either the bibliographic (ger)
// or terminology (deu) form; users tend to type the two-letter 639-1 code.
// Everything is folded onto one three-letter code so "en", "eng" and
// "english" all match the same tracks.
const LANGUAGE_ALIASES: Record<string, string> = {
  en: "eng", english: "eng",
  ja: "jpn", japanese: "jpn",
  es: "spa", spanish: "spa",
  fr: "fra", fre: "fra", french: "fra",
  de: "deu", ger: "deu", german: "deu",
  it: "ita", italian: "ita",
  pt: "por", portuguese: "por",
  ru: "rus", russian: "rus",
  zh: "zho", chi: "zho", chinese: "zho",
  ko: "kor", korean: "kor",
  nl: "nld", dut: "nld", dutch: "nld",
  sv: "swe", swedish: "swe",
  no: "nor", nb: "nor", nob: "nor", norwegian: "nor",
  da: "dan", danish: "dan",
  fi: "fin", finnish: "fin",
  pl: "pol", polish: "pol",
  cs: "ces", cze: "ces", czech: "ces",
  sk: "slk", slo: "slk", slovak: "slk",
  el: "ell", gre: "ell", greek: "ell",
  tr: "tur", turkish: "tur",
  ar: "ara", arabic: "ara",
  he: "heb", hebrew: "heb",
  hi: "hin", hindi: "hin",
  hu: "hun", hungarian: "hun",
  ro: "ron", rum: "ron", romanian: "ron",
  fa: "fas", per: "fas", persian: "fas",
  th: "tha", thai: "tha",
  vi: "vie", vietnamese: "vie",
  id: "ind", indonesian: "ind",
  ms: "msa", may: "msa", malay: "msa",
  uk: "ukr", ukrainian: "ukr",
  is: "isl", ice: "isl", icelandic: "isl",
  sq: "sqi", alb: "sqi",
  hy: "hye", arm: "hye",
  eu: "eus", baq: "eus",
  my: "mya", bur: "mya",
  ka: "kat", geo: "kat",
  mk: "mkd", mac: "mkd",
  mi: "mri", mao: "mri",
  bo: "bod", tib: "bod",
  cy: "cym", wel: "cym",
};

const UNTAGGED = new Set(["", "und", "unk", "unknown", "mis", "zxx"]);

export function normalizeLanguage(code: string | undefined): string {
  const lower = (code ?? "").trim().toLowerCase();
  if (UNTAGGED.has(lower)) return "und";
  return LANGUAGE_ALIASES[lower] ?? lower;
}

function languageFilter(wanted: readonly string[]): ((language: string) => boolean) | null {
  const set = new Set(wanted.map(normalizeLanguage).filter((l) => l !== "und"));
  if (set.size === 0) return null;
  return (language) => {
    const normalized = normalizeLanguage(language);
    return normalized === "und" || set.has(normalized);
  };
}

export interface StreamSelection {
  audio: AudioTrack[];
  subtitles: SubtitleTrack[];
  // The kept track to downmix into an added AAC 2.0 track, if one is needed.
  stereoSource?: AudioTrack;
  droppedAudio: number;
  droppedSubtitles: number;
}

/**
 * Works out which audio and subtitle tracks a preset keeps. Returns null when
 * the probe has no per-track info (older index rows), in which case callers
 * fall back to mapping every track.
 */
export function selectStreams(probe: Pick<MediaProbe, "audioTracks" | "subtitleTracks">, preset: Preset): StreamSelection | null {
  const allAudio = probe.audioTracks;
  const allSubs = probe.subtitleTracks;
  if (!allAudio || !allSubs) return null;

  const audioMatch = languageFilter(preset.keepAudioLanguages ?? []);
  let audio = audioMatch ? allAudio.filter((t) => audioMatch(t.language)) : allAudio;
  // Never strip a file down to silence because its tags don't match.
  if (audio.length === 0) audio = allAudio;

  let subtitles: SubtitleTrack[] = [];
  if (preset.subtitleMode !== "drop") {
    const subMatch = languageFilter(preset.keepSubtitleLanguages ?? []);
    subtitles = subMatch ? allSubs.filter((t) => subMatch(t.language)) : allSubs;
  }

  let stereoSource: AudioTrack | undefined;
  if (preset.addStereoAudio && audio.length > 0 && audio.every((t) => t.channels > 2)) {
    stereoSource = audio.find((t) => t.isDefault) ?? audio[0];
  }

  return {
    audio,
    subtitles,
    stereoSource,
    droppedAudio: allAudio.length - audio.length,
    droppedSubtitles: allSubs.length - subtitles.length,
  };
}

const MAX_HEIGHT: Record<Exclude<Preset["maxResolution"], "none">, number> = {
  "2160p": 2160,
  "1440p": 1440,
  "1080p": 1080,
  "720p": 720,
  "480p": 480,
};

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Target frame size when the source is larger than the preset allows, fitting
 * inside a 16:9 box of maxResolution's height so ultra-wide (2.39:1) and 4:3
 * sources are both bounded sensibly. Returns null when no scaling is needed.
 */
export function downscaleTarget(
  width: number,
  height: number,
  maxResolution: Preset["maxResolution"] | undefined,
): { width: number; height: number } | null {
  if (!maxResolution || maxResolution === "none" || width <= 0 || height <= 0) return null;
  const maxH = MAX_HEIGHT[maxResolution];
  const maxW = Math.round((maxH * 16) / 9);
  // Small slack so a 1920x1088 encode isn't "downscaled" to 1080.
  if (width <= maxW * 1.02 && height <= maxH * 1.02) return null;
  const ratio = Math.min(maxW / width, maxH / height);
  return { width: even(width * ratio), height: even(height * ratio) };
}

// Containers that predate proper support for modern codecs, chapters or
// multiple tracks. A file in one of these is worth remuxing even when the
// video itself doesn't need re-encoding.
const LEGACY_CONTAINERS = new Set(["avi", "asf", "flv", "mpeg", "mpegts", "vob", "mpegvideo", "rm"]);

export function isLegacyContainer(container: string): boolean {
  return LEGACY_CONTAINERS.has(container.toLowerCase());
}

// Video codecs MP4 can carry without re-encoding. MKV takes nearly anything.
const MP4_VIDEO_CODECS = new Set(["h264", "hevc", "av1", "mpeg4", "vp9"]);

export function canCopyVideoInto(videoCodec: string, container: Preset["targetContainer"]): boolean {
  return container === "mkv" || MP4_VIDEO_CODECS.has(videoCodec.toLowerCase());
}
