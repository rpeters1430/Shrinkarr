import type { Preset } from "../config/schema.js";
import type { MediaSnapshot } from "../db/historyRepo.js";
import type { PolicyMetadata } from "../media/types.js";
import { selectStreams } from "../transcode/streams.js";

/**
 * What a preset does to one file's audio and subtitle tracks, keyed by
 * source stream index so the UI can lay it over the tracks it already has.
 */
export interface TrackPlan {
  presetId: string;
  removed: number[];
  // Kept audio, then kept subtitles, in output order.
  order: number[];
  defaultAudio: number | null;
  // New title per renamed track; null clears it.
  renamed: Record<number, string | null>;
  addsStereo: boolean;
  // Whether processing the file changes its tracks at all.
  changes: boolean;
}

export function planTracks(metadata: PolicyMetadata | null | undefined, preset: Preset): TrackPlan | null {
  if (!metadata || metadata.mediaKind !== "video" || preset.mediaKind === "audio") return null;
  const selection = selectStreams(metadata, preset);
  if (!selection) return null;
  const kept = new Set([...selection.audio, ...selection.subtitles].map((track) => track.index));
  const removed = [...(metadata.audioTracks ?? []), ...(metadata.subtitleTracks ?? [])]
    .map((track) => track.index)
    .filter((index) => !kept.has(index));
  const renamed: Record<number, string | null> = {};
  for (const [index, title] of selection.titles) renamed[index] = title ?? null;
  const addsStereo = selection.stereoSource !== undefined;
  return {
    presetId: preset.id,
    removed,
    order: [...selection.audio, ...selection.subtitles].map((track) => track.index),
    defaultAudio: selection.defaultAudio?.index ?? null,
    renamed,
    addsStereo,
    changes: removed.length > 0 || selection.reordered || selection.defaultChanged || selection.titles.size > 0 || addsStereo,
  };
}

/**
 * The tracks the output file will have, in the same shape History records
 * after a job. index is the planned output stream number (the video is 0).
 */
export function plannedTracks(metadata: PolicyMetadata | null | undefined, preset: Preset): Pick<MediaSnapshot, "audio" | "subtitles"> | null {
  if (!metadata || metadata.mediaKind !== "video" || preset.mediaKind === "audio") return null;
  const selection = selectStreams(metadata, preset);
  if (!selection) return null;
  const title = (index: number, current: string | undefined) => (selection.titles.has(index) ? selection.titles.get(index) : current);
  // Mirrors the audio codec choice in buildFfmpegArgs.
  const audioCodec = preset.audioMode === "aac" || preset.audioMode === "ac3"
    ? preset.audioMode
    : preset.audioMode === "smart" && metadata.isLosslessAudio ? "aac" : undefined;
  let stream = 1;
  const audio: MediaSnapshot["audio"] = selection.audio.map((t) => ({
    index: stream++,
    codec: audioCodec ?? t.codec,
    channels: t.channels,
    language: t.language,
    title: title(t.index, t.title),
    isDefault: selection.defaultAudio ? t === selection.defaultAudio : t.isDefault,
    commentary: t.isCommentary,
  }));
  if (selection.stereoSource) {
    audio.push({
      index: stream++,
      codec: "aac",
      channels: 2,
      language: selection.stereoSource.language,
      title: preset.cleanTrackNames ? undefined : "Stereo",
      isDefault: false,
    });
  }
  const subtitles: MediaSnapshot["subtitles"] = selection.subtitles.map((t) => ({
    index: stream++,
    codec: preset.targetContainer === "mp4" ? "mov_text" : t.codec,
    language: t.language,
    forced: t.isForced,
    title: title(t.index, t.title),
    commentary: t.isCommentary,
    hearingImpaired: t.isHearingImpaired,
  }));
  return { audio, subtitles };
}
