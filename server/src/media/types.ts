export interface AudioTrack {
  // Absolute stream index in the file, as used by "-map 0:<index>".
  index: number;
  codec: string;
  channels: number;
  language: string;
  title?: string;
  isDefault: boolean;
}

export interface SubtitleTrack {
  index: number;
  codec: string;
  language: string;
  title?: string;
  isForced: boolean;
}

export interface MediaProbe {
  mediaKind: "video" | "audio";
  durationSeconds: number;
  videoDurationSeconds?: number;
  sizeBytes: number;
  videoCodec: string;
  container: string;
  width: number;
  height: number;
  resolutionLabel: "4K" | "1440p" | "1080p" | "720p" | "480p" | "SD";
  bitrateKbps: number;
  bitDepth: 8 | 10 | 12;
  isHdr: boolean;
  colorTransfer?: string;
  fps: number;
  audioCodec: string;
  audioChannels: number;
  subtitleCount: number;
  // Audio-only: whether the source audio stream is a lossless codec (FLAC, ALAC, WAV/PCM, etc).
  // Undefined/false for video files.
  isLosslessAudio?: boolean;
  audioTracks?: AudioTrack[];
  subtitleTracks?: SubtitleTrack[];
}

// Fields used by scanner policy that are not already stored in dedicated file
// columns. Kept nullable on older database rows until the next successful scan.
export interface PolicyMetadata {
  mediaKind: MediaProbe["mediaKind"];
  fps: number;
  colorTransfer?: string | null;
  isLosslessAudio?: boolean;
  audioTracks?: AudioTrack[];
  subtitleTracks?: SubtitleTrack[];
}

export interface FfprobeStream {
  index?: number;
  codec_type: string;
  codec_name: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  color_transfer?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  bit_rate?: string;
  duration?: string;
  duration_ts?: string | number;
  time_base?: string;
  channels?: number;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
}

export interface FfprobeFormat {
  duration?: string;
  size?: string;
  bit_rate?: string;
  format_name?: string;
}

export interface FfprobeOutput {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}
