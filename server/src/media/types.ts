export interface MediaProbe {
  durationSeconds: number;
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
}

export interface FfprobeStream {
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
  channels?: number;
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
