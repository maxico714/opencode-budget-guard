import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BoundedMap, effectiveThreshold, pushBounded } from "../src/window.js";

describe("BoundedMap", () => {
  it("evicts the least recently used key at the cap", () => {
    const map = new BoundedMap<number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.get("a");
    map.set("c", 3);
    assert.equal(map.get("b"), undefined);
    assert.equal(map.get("a"), 1);
    assert.equal(map.get("c"), 3);
  });

  it("returns an iteration-safe snapshot of entries", () => {
    const map = new BoundedMap<number>(2);
    map.set("a", 1);
    map.set("b", 2);
    const seen: number[] = [];
    for (const [key] of map.entries()) {
      const value = map.get(key);
      assert.ok(value !== undefined);
      seen.push(value);
    }
    assert.deepEqual(seen, [1, 2]);
    assert.equal(map.size, 2);
  });

  it("overwrites without growing the map", () => {
    const map = new BoundedMap<number>(2);
    map.set("a", 1);
    map.set("a", 2);
    assert.equal(map.size, 1);
    assert.equal(map.get("a"), 2);
  });
});

describe("pushBounded", () => {
  it("drops samples older than the window", () => {
    assert.deepEqual(pushBounded([1_000, 2_000], 10_000, 1_000), [10_000]);
  });

  it("caps stored samples while keeping the newest", () => {
    const samples: number[] = [];
    let current = samples;
    for (let index = 0; index < 300; index += 1) current = pushBounded(current, index, 10_000);
    assert.equal(current.length, 256);
    assert.equal(current[current.length - 1], 299);
  });

  it("keeps samples exactly on the window edge", () => {
    assert.deepEqual(pushBounded([9_000], 10_000, 1_000), [9_000, 10_000]);
  });
});

describe("effectiveThreshold", () => {
  it("treats zero and negative thresholds as one sample", () => {
    assert.equal(effectiveThreshold(0), 1);
    assert.equal(effectiveThreshold(-4), 1);
    assert.equal(effectiveThreshold(3), 3);
  });
});
