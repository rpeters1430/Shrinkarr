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
  // The rest of the names Sonarr and Radarr use for an original language.
  armenian: "hye", basque: "eus", georgian: "kat", macedonian: "mkd", albanian: "sqi",
  flemish: "nld",
  bg: "bul", bulgarian: "bul",
  lt: "lit", lithuanian: "lit",
  lv: "lav", latvian: "lav",
  et: "est", estonian: "est",
  ca: "cat", catalan: "cat",
  hr: "hrv", scr: "hrv", croatian: "hrv",
  sr: "srp", scc: "srp", serbian: "srp",
  bs: "bos", bosnian: "bos",
  sl: "slv", slovenian: "slv",
  bn: "ben", bengali: "ben",
  ta: "tam", tamil: "tam",
  te: "tel", telugu: "tel",
  ml: "mal", malayalam: "mal",
  kn: "kan", kannada: "kan",
  mr: "mar", marathi: "mar",
  ur: "urd", urdu: "urd",
  tl: "tgl", fil: "tgl", tagalog: "tgl", filipino: "tgl",
  af: "afr", afrikaans: "afr",
  mn: "mon", mongolian: "mon",
  rm: "roh", romansh: "roh",
};

const UNTAGGED = new Set(["", "und", "unk", "unknown", "mis", "zxx"]);

export function normalizeLanguage(code: string | undefined): string {
  const lower = (code ?? "").trim().toLowerCase();
  if (UNTAGGED.has(lower)) return "und";
  return LANGUAGE_ALIASES[lower] ?? lower;
}

// Stands for the title's original language in keepAudioLanguages and
// keepSubtitleLanguages.
export const ORIGINAL_LANGUAGE = "original";

export function usesOriginalLanguage(preset: Pick<Preset, "keepAudioLanguages" | "keepSubtitleLanguages">): boolean {
  return [...(preset.keepAudioLanguages ?? []), ...(preset.keepSubtitleLanguages ?? [])]
    .some((language) => language.trim().toLowerCase() === ORIGINAL_LANGUAGE);
}

// A preset language list as normalized codes in priority order, with
// "original" swapped for the title's language or left out when unknown.
function expandLanguages(wanted: readonly string[], originalLanguage: string | null | undefined): string[] {
  const out: string[] = [];
  for (const entry of wanted) {
    const code = entry.trim().toLowerCase() === ORIGINAL_LANGUAGE
      ? (originalLanguage ? normalizeLanguage(originalLanguage) : "und")
      : normalizeLanguage(entry);
    if (code !== "und" && !out.includes(code)) out.push(code);
  }
  return out;
}

const COMMENTARY_TITLE = /commentary/i;
const HEARING_IMPAIRED_TITLE = /\bsdh\b|\bcc\b|hearing[ -]?impaired|[([]hi[)\]]/i;
const FORCED_TITLE = /\bforced\b/i;

function isCommentary(track: AudioTrack | SubtitleTrack): boolean {
  return track.isCommentary === true || COMMENTARY_TITLE.test(track.title ?? "");
}

function isHearingImpaired(track: SubtitleTrack): boolean {
  return track.isHearingImpaired === true || HEARING_IMPAIRED_TITLE.test(track.title ?? "");
}

function isForced(track: SubtitleTrack): boolean {
  return track.isForced || FORCED_TITLE.test(track.title ?? "");
}

// Rough quality order of audio codecs, lossless first.
const AUDIO_CODEC_RANK: Record<string, number> = {
  truehd: 9, mlp: 9, flac: 8, alac: 8, dts: 7, eac3: 6, ac3: 5, opus: 4, aac: 3, vorbis: 2, mp3: 1, mp2: 0,
};

function audioRank(track: AudioTrack): number {
  const codec = track.codec.startsWith("pcm_") ? 8 : (AUDIO_CODEC_RANK[track.codec] ?? 0);
  return track.channels * 100 + codec * 10 + (track.isDefault ? 1 : 0);
}

const TEXT_SUBTITLE_CODECS = new Set(["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"]);

// Full subtitles first, then SDH; text ahead of image-based (PGS, VobSub),
// which can't be converted for MP4 output.
function subtitleRank(track: SubtitleTrack): number {
  return (isHearingImpaired(track) ? 0 : 2) + (TEXT_SUBTITLE_CODECS.has(track.codec) ? 1 : 0);
}

// Keeps at most `max` tracks per language, the highest-ranked ones, in their
// original order. Untagged tracks aren't limited since they may be anything.
function limitPerLanguage<T extends { language: string }>(
  tracks: T[],
  max: number,
  rank: (track: T) => number,
  exempt: (track: T) => boolean = () => false,
): T[] {
  if (max <= 0) return tracks;
  const groups = new Map<string, T[]>();
  for (const track of tracks) {
    const language = normalizeLanguage(track.language);
    if (language === "und" || exempt(track)) continue;
    groups.set(language, [...(groups.get(language) ?? []), track]);
  }
  const keep = new Set<T>();
  for (const group of groups.values()) {
    // Array.prototype.sort is stable, so equal ranks keep file order.
    for (const track of [...group].sort((a, b) => rank(b) - rank(a)).slice(0, max)) keep.add(track);
  }
  return tracks.filter((track) => keep.has(track) || normalizeLanguage(track.language) === "und" || exempt(track));
}

// Stable sort by position in the language list; languages not in it
// (untagged tracks, or every track when the list is empty) go last.
function sortByLanguage<T extends { language: string }>(tracks: T[], priority: string[]): T[] {
  const position = (track: T) => {
    const index = priority.indexOf(normalizeLanguage(track.language));
    return index === -1 ? priority.length : index;
  };
  return [...tracks].sort((a, b) => position(a) - position(b));
}

const NOISE_WORDS = new Set([
  "aac", "ac", "ac3", "eac3", "dd", "ddp", "dd+", "dolby", "digital", "plus", "atmos", "truehd", "true", "hd",
  "dts", "ma", "x", "es", "hra", "flac", "pcm", "lpcm", "opus", "mp3", "vorbis", "lossless", "e",
  "srt", "subrip", "ass", "ssa", "pgs", "vobsub", "sup", "webvtt", "text",
  "ch", "channel", "channels", "stereo", "mono", "surround",
  "audio", "sub", "subs", "subtitle", "subtitles", "track", "original", "main", "default", "full",
  "kbps", "kb", "khz", "hz", "bit", "und",
]);
const NOISE_NUMBER = /^\d+([.,]\d+)?(kbps|kb|k|khz|hz|bit|ch)?$/;
const LANGUAGE_CODES = new Set(Object.values(LANGUAGE_ALIASES));
// Never noise, even where they double as a language code ("hi" is Hindi).
const MEANINGFUL_WORDS = new Set(["sdh", "cc", "hi", "forced", "commentary"]);

function isNoiseWord(word: string): boolean {
  if (MEANINGFUL_WORDS.has(word)) return false;
  return NOISE_WORDS.has(word) || NOISE_NUMBER.test(word) || LANGUAGE_CODES.has(word) || normalizeLanguage(word) !== word;
}

/**
 * A track title with nothing in it a player doesn't already show (codec,
 * channels, language, bitrate) comes back empty. Anything else is returned
 * unchanged. Cleaning a cleaned title changes nothing, so a cleaned file
 * isn't remuxed again.
 */
export function cleanTrackTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const words = title.toLowerCase().split(/[^a-z0-9.+,]+/).map((w) => w.replace(/^[.,]+|[.,]+$/g, "")).filter(Boolean);
  return words.every(isNoiseWord) ? undefined : title;
}

export interface StreamSelection {
  // Kept tracks in output order.
  audio: AudioTrack[];
  subtitles: SubtitleTrack[];
  // The kept track to downmix into an added AAC 2.0 track, if one is needed.
  stereoSource?: AudioTrack;
  droppedAudio: number;
  droppedSubtitles: number;
  // Set when reorderTracks is on: the audio track to flag as the default.
  defaultAudio?: AudioTrack;
  // Output title per kept track when cleanTrackNames changes it (undefined
  // clears the title), keyed by source stream index.
  titles: Map<number, string | undefined>;
  // Whether the output differs from the source in ways other than dropped
  // tracks: order, default audio, or titles.
  reordered: boolean;
  defaultChanged: boolean;
}

function orderChanged(tracks: Array<{ index: number }>): boolean {
  return tracks.some((track, i) => i > 0 && track.index < tracks[i - 1].index);
}

/**
 * Works out which audio and subtitle tracks a preset keeps, and in what
 * order. Returns null when the probe has no per-track info (older index
 * rows), in which case callers fall back to mapping every track.
 */
export function selectStreams(
  probe: Pick<MediaProbe, "audioTracks" | "subtitleTracks" | "originalLanguage">,
  preset: Preset,
): StreamSelection | null {
  const allAudio = probe.audioTracks;
  const allSubs = probe.subtitleTracks;
  if (!allAudio || !allSubs) return null;

  const audioLanguages = expandLanguages(preset.keepAudioLanguages ?? [], probe.originalLanguage);
  const subtitleLanguages = expandLanguages(preset.keepSubtitleLanguages ?? [], probe.originalLanguage);
  const matches = (languages: string[]) => (track: { language: string }) => {
    if (languages.length === 0) return true;
    const language = normalizeLanguage(track.language);
    return language === "und" || languages.includes(language);
  };

  let audio = allAudio.filter(matches(audioLanguages));
  if (preset.removeCommentaryTracks) audio = audio.filter((t) => !isCommentary(t));
  const rankAudio = preset.audioTrackPreference === "size" ? (t: AudioTrack) => -audioRank(t) : audioRank;
  audio = limitPerLanguage(audio, preset.maxAudioTracksPerLanguage ?? 0, rankAudio);
  // Never strip a file down to silence because its tags don't match.
  if (audio.length === 0) audio = allAudio;

  let subtitles: SubtitleTrack[] = [];
  if (preset.subtitleMode !== "drop") {
    subtitles = allSubs.filter(matches(subtitleLanguages));
    if (preset.removeCommentaryTracks) subtitles = subtitles.filter((t) => !isCommentary(t));
    if (preset.removeHearingImpairedSubtitles) {
      const regular = new Set(subtitles
        .filter((t) => !isHearingImpaired(t) && !isForced(t))
        .map((t) => normalizeLanguage(t.language)));
      subtitles = subtitles.filter((t) => !isHearingImpaired(t) || !regular.has(normalizeLanguage(t.language)));
    }
    subtitles = limitPerLanguage(subtitles, preset.maxSubtitleTracksPerLanguage ?? 0, subtitleRank, isForced);
  }

  let defaultAudio: AudioTrack | undefined;
  if (preset.reorderTracks) {
    audio = sortByLanguage(audio, audioLanguages);
    subtitles = sortByLanguage(subtitles, subtitleLanguages);
    defaultAudio = audio[0];
  }

  const titles = new Map<number, string | undefined>();
  if (preset.cleanTrackNames) {
    for (const track of [...audio, ...subtitles]) {
      const cleaned = cleanTrackTitle(track.title);
      if (cleaned !== track.title) titles.set(track.index, cleaned);
    }
  }

  let stereoSource: AudioTrack | undefined;
  if (preset.addStereoAudio && audio.length > 0 && audio.every((t) => t.channels > 2)) {
    stereoSource = defaultAudio ?? audio.find((t) => t.isDefault) ?? audio[0];
  }

  return {
    audio,
    subtitles,
    stereoSource,
    droppedAudio: allAudio.length - audio.length,
    droppedSubtitles: allSubs.length - subtitles.length,
    defaultAudio,
    titles,
    reordered: orderChanged(audio) || orderChanged(subtitles),
    defaultChanged: defaultAudio !== undefined && audio.some((t) => t.isDefault !== (t === defaultAudio)),
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
