export interface MediaProbe {
  durationSeconds: number;
  sizeBytes: number;
  videoCodec: string;
  container: string;
  width: number;
  height: number;
  audioCodec: string;
}

export interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
}

export interface FfprobeFormat {
  duration?: string;
  size?: string;
  format_name?: string;
}

export interface FfprobeOutput {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}
