const MAX_SAMPLES_PER_KEY = 256;
const MAX_KEYS = 4096;

/** Insertion-ordered map with a hard key cap; reading a key refreshes its position. */
export class BoundedMap<V> {
  private readonly items = new Map<string, V>();

  constructor(private readonly maxKeys: number = MAX_KEYS) {}

  get(key: string): V | undefined {
    const value = this.items.get(key);
    if (value === undefined) return undefined;
    this.items.delete(key);
    this.items.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (this.items.has(key)) this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.maxKeys) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }
  }

  get size(): number {
    return this.items.size;
  }

  /** Snapshot of the live entries; safe to iterate while calling `get`. */
  entries(): [string, V][] {
    return [...this.items.entries()];
  }
}

export function pushBounded(samples: number[], ts: number, windowMs: number): number[] {
  samples.push(ts);
  const cutoff = ts - windowMs;
  let keepFrom = 0;
  while (keepFrom < samples.length && (samples[keepFrom] ?? 0) < cutoff) keepFrom += 1;
  const pruned = keepFrom === 0 ? samples : samples.slice(keepFrom);
  return pruned.length > MAX_SAMPLES_PER_KEY ? pruned.slice(pruned.length - MAX_SAMPLES_PER_KEY) : pruned;
}

export function effectiveThreshold(threshold: number): number {
  return Math.max(1, threshold);
}
