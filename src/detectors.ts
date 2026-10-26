import type { GuardConfig } from "./config.js";
import type { DetectorHit } from "./types.js";
import { BoundedMap, effectiveThreshold, pushBounded } from "./window.js";

interface OscillationSample {
  readonly ts: number;
  readonly hash: string;
}

export interface ToolCallSample {
  readonly tool: string;
  readonly inputHash: string;
  readonly path: string | null;
  readonly ts: number;
}

export interface ToolFailureSample {
  readonly tool: string;
  readonly errorSignature: string;
  readonly ts: number;
}

/**
 * Per-session loop detectors. Every sample list is windowed and capped, so memory
 * stays bounded no matter how long the session runs.
 */
export class Detectors {
  private readonly repeatSamples = new BoundedMap<number[]>();
  private readonly failureSamples = new BoundedMap<number[]>();
  private readonly oscillationSamples = new BoundedMap<OscillationSample[]>();
  private readonly oscillationCounts = new BoundedMap<number[]>();

  constructor(private readonly config: GuardConfig["detectors"]) {}

  onToolCall(sample: ToolCallSample): DetectorHit[] {
    const hits: DetectorHit[] = [];
    const repeat = this.config.tool_repeat;
    if (repeat.enabled) {
      const key = `${sample.tool}\u0000${sample.inputHash}`;
      const windowMs = repeat.window_seconds * 1000;
      const samples = pushBounded(this.repeatSamples.get(key) ?? [], sample.ts, windowMs);
      this.repeatSamples.set(key, samples);
      const threshold = effectiveThreshold(repeat.threshold);
      if (samples.length >= threshold) {
        hits.push({
          detector: "tool_repeat",
          key,
          detail: `tool '${sample.tool}' called with identical input ${samples.length} times within ${repeat.window_seconds}s`,
          count: samples.length,
          threshold,
          ts: sample.ts,
        });
      }
    }

    const oscillation = this.config.oscillation;
    if (oscillation.enabled && sample.path !== null) {
      const key = `${sample.tool}\u0000${sample.path}`;
      const windowMs = oscillation.window_seconds * 1000;
      const sequence = pushOscillation(
        this.oscillationSamples.get(key) ?? [],
        { ts: sample.ts, hash: sample.inputHash },
        windowMs,
      );
      this.oscillationSamples.set(key, sequence);
      if (isAlternation(sequence)) {
        const counts = pushBounded(this.oscillationCounts.get(key) ?? [], sample.ts, windowMs);
        this.oscillationCounts.set(key, counts);
        const threshold = effectiveThreshold(oscillation.count);
        if (counts.length >= threshold) {
          hits.push({
            detector: "oscillation",
            key,
            detail: `'${sample.tool}' alternated inputs on '${sample.path}' ${counts.length} times within ${oscillation.window_seconds}s`,
            count: counts.length,
            threshold,
            ts: sample.ts,
          });
        }
      }
    }
    return hits;
  }

  onToolFailure(sample: ToolFailureSample): DetectorHit[] {
    const detector = this.config.identical_fail;
    if (!detector.enabled) return [];
    const key = `${sample.tool}\u0000${sample.errorSignature}`;
    const windowMs = detector.window_seconds * 1000;
    const samples = pushBounded(this.failureSamples.get(key) ?? [], sample.ts, windowMs);
    this.failureSamples.set(key, samples);
    const threshold = effectiveThreshold(detector.threshold);
    if (samples.length < threshold) return [];
    return [
      {
        detector: "identical_fail",
        key,
        detail: `tool '${sample.tool}' failed ${samples.length} times with the same error within ${detector.window_seconds}s`,
        count: samples.length,
        threshold,
        ts: sample.ts,
      },
    ];
  }

  keyCount(): number {
    return (
      this.repeatSamples.size + this.failureSamples.size + this.oscillationSamples.size + this.oscillationCounts.size
    );
  }
}

function pushOscillation(
  sequence: OscillationSample[],
  sample: OscillationSample,
  windowMs: number,
): OscillationSample[] {
  const cutoff = sample.ts - windowMs;
  const next = sequence.filter((item) => item.ts >= cutoff);
  next.push(sample);
  return next.length > 8 ? next.slice(next.length - 8) : next;
}

function isAlternation(sequence: OscillationSample[]): boolean {
  if (sequence.length < 3) return false;
  const first = sequence[sequence.length - 3]?.hash;
  const middle = sequence[sequence.length - 2]?.hash;
  const last = sequence[sequence.length - 1]?.hash;
  return first !== undefined && middle !== undefined && last !== undefined && first === last && middle !== last;
}
