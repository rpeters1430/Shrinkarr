# Shrinkarr video quality gate design

## Goal

Let users opt in to checking the encoded video against the source before Shrinkarr replaces the original. Reject the temporary output when its measured structural similarity falls below the configured threshold.

## Scope

- Add a queue-level `qualityGate` setting with `enabled` defaulting to `false` and a configurable minimum SSIM score, default `0.95`.
- For video re-encodes only, run FFmpeg's SSIM filter over the complete source and output video streams after existing structural and size verification and before atomic replacement.
- Resize the output frames to the source dimensions for comparison, align both streams to a zero start timestamp, and compare synchronized frames.
- Require both video-stream durations to be available and within two source frames (or 100 ms) before comparing. The existing wider container-duration tolerance is not sufficient to prove video-tail coverage.
- Log the command and measured score. A score below threshold rejects and removes the temporary output while preserving the original.
- Fail closed when the filter cannot run or FFmpeg does not produce a parseable finite score. Cancellation must stop the metric process and follow the normal job cancellation path.
- Skip the gate for audio jobs and video remuxes because they do not re-encode video. This is recorded in the job log when the gate is enabled.
- Expose the setting and threshold in Settings; preserve defaults for existing config files.

## Behavior

- SSIM is in `[0, 1]`; higher means the compared frames are more structurally similar.
- The comparison runs against every frame and can add substantial CPU and I/O cost. It is explicitly opt-in and uses the existing low-priority and cancellation controls.
- A lower score than the configured minimum is a verification failure; the original remains untouched.
- Missing metrics, unsupported FFmpeg filters, probe/decoder failures, and malformed scores are failures, never implicit passes.
- The gate does not claim to measure subjective quality or audio quality. Existing stream, duration, health, size, and atomic replacement checks remain active.

## Acceptance

- Existing configs parse with the gate disabled.
- Threshold bounds reject invalid config values.
- SSIM parsing handles valid, missing, malformed, and non-finite output.
- A low score, missing metric, or FFmpeg failure prevents replacement; a passing score continues through existing replacement logic.
- Cancelled metric runs do not replace or fail the job as a quality rejection.
- Build, lint, server/web tests, and a local FFmpeg smoke test pass.
