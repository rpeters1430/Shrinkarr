// Shared by the ffmpeg runs that only decode (health checks and the SSIM
// gate). No -hwaccel_output_format, so decoded frames come back to system
// memory for the null muxer and the ssim filter, and ffmpeg drops to software
// decode on its own when the GPU can't handle a codec or profile.
export function vaapiDecodeArgs(device: string): string[] {
  return ["-hwaccel", "vaapi", "-hwaccel_device", device];
}

// Lines ffmpeg prints when the VAAPI device or hwaccel couldn't be used. These
// say nothing about the file, so the caller re-runs the decode on the CPU.
const HW_DECODE_FAILURE_PATTERNS = [
  /hwaccel/i,
  /failed setup for format/i,
  /no support for codec .* profile/i,
  /device creation failed/i,
  /\bvaapi\b/i,
  /\bva[A-Z]\w+/,
  /libva/i,
  /hw ?frames?\b/i,
  /hw surface/i,
  /decode issue/i,
];

export function hwDecodeFailureLine(lines: string[]): string | undefined {
  return lines.find((line) => HW_DECODE_FAILURE_PATTERNS.some((pattern) => pattern.test(line)));
}
