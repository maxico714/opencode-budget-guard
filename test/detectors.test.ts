import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveConfig } from "../src/config.js";
import { Detectors } from "../src/detectors.js";
import { T0 } from "./helpers.js";

function detectors(overrides: Record<string, unknown> = {}): Detectors {
  return new Detectors(resolveConfig(overrides).detectors);
}

describe("tool_repeat", () => {
  it("triggers at the configured threshold", () => {
    const detector = detectors({ detectors: { tool_repeat: { threshold: 3 } } });
    const sample = { tool: "read", inputHash: "abc", path: null, ts: T0 };
    assert.equal(detector.onToolCall(sample).length, 0);
    assert.equal(detector.onToolCall({ ...sample, ts: T0 + 1000 }).length, 0);
    const hits = detector.onToolCall({ ...sample, ts: T0 + 2000 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.detector, "tool_repeat");
    assert.equal(hits[0]?.count, 3);
    assert.equal(hits[0]?.threshold, 3);
  });

  it("does not mix different tool names or different inputs", () => {
    const detector = detectors({ detectors: { tool_repeat: { threshold: 3 } } });
    detector.onToolCall({ tool: "read", inputHash: "a", path: null, ts: T0 });
    detector.onToolCall({ tool: "read", inputHash: "b", path: null, ts: T0 + 1 });
    detector.onToolCall({ tool: "write", inputHash: "a", path: null, ts: T0 + 2 });
    assert.equal(detector.onToolCall({ tool: "read", inputHash: "a", path: null, ts: T0 + 3 }).length, 0);
  });

  it("prunes samples outside the window", () => {
    const detector = detectors({ detectors: { tool_repeat: { threshold: 3, window_seconds: 10 } } });
    const sample = { tool: "read", inputHash: "abc", path: null };
    detector.onToolCall({ ...sample, ts: T0 });
    detector.onToolCall({ ...sample, ts: T0 + 1000 });
    assert.equal(detector.onToolCall({ ...sample, ts: T0 + 20_000 }).length, 0);
  });

  it("treats threshold 0 as 'trigger on first sample'", () => {
    const detector = detectors({ detectors: { tool_repeat: { threshold: 0 } } });
    const hits = detector.onToolCall({ tool: "read", inputHash: "abc", path: null, ts: T0 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.threshold, 1);
  });

  it("is skipped when disabled", () => {
    const detector = detectors({ detectors: { tool_repeat: { enabled: false, threshold: 1 } } });
    assert.equal(detector.onToolCall({ tool: "read", inputHash: "abc", path: null, ts: T0 }).length, 0);
  });
});

describe("identical_fail", () => {
  it("triggers on repeated identical error signatures", () => {
    const detector = detectors({ detectors: { identical_fail: { threshold: 2 } } });
    const sample = { tool: "edit", errorSignature: "not found <path>", ts: T0 };
    assert.equal(detector.onToolFailure(sample).length, 0);
    const hits = detector.onToolFailure({ ...sample, ts: T0 + 1000 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.detector, "identical_fail");
  });

  it("separates different error signatures", () => {
    const detector = detectors({ detectors: { identical_fail: { threshold: 2 } } });
    detector.onToolFailure({ tool: "edit", errorSignature: "e1", ts: T0 });
    assert.equal(detector.onToolFailure({ tool: "edit", errorSignature: "e2", ts: T0 + 1 }).length, 0);
  });
});

describe("oscillation", () => {
  it("triggers on an A,B,A input alternation for the same path", () => {
    const detector = detectors({ detectors: { oscillation: { count: 1 } } });
    assert.equal(detector.onToolCall({ tool: "write", inputHash: "A", path: "a.txt", ts: T0 }).length, 0);
    assert.equal(detector.onToolCall({ tool: "write", inputHash: "B", path: "a.txt", ts: T0 + 1000 }).length, 0);
    const hits = detector.onToolCall({ tool: "write", inputHash: "A", path: "a.txt", ts: T0 + 2000 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.detector, "oscillation");
    assert.match(hits[0]?.detail ?? "", /a\.txt/);
  });

  it("requires the configured number of alternations", () => {
    const detector = detectors({ detectors: { oscillation: { count: 2 } } });
    const sequence = ["A", "B", "A", "B", "A"];
    const results = sequence.map((hash, index) =>
      detector.onToolCall({ tool: "write", inputHash: hash, path: "a.txt", ts: T0 + index * 1000 }),
    );
    assert.equal(results[2]?.length, 0);
    assert.equal(results[4]?.length, 1);
  });

  it("does not trigger for monotonic writes", () => {
    const detector = detectors({ detectors: { oscillation: { count: 1 } } });
    for (const [index, hash] of ["A", "B", "C", "D"].entries()) {
      assert.equal(
        detector.onToolCall({ tool: "write", inputHash: hash, path: "a.txt", ts: T0 + index * 1000 }).length,
        0,
      );
    }
  });

  it("does not mix different paths or tools", () => {
    const detector = detectors({ detectors: { oscillation: { count: 1 } } });
    detector.onToolCall({ tool: "write", inputHash: "A", path: "a.txt", ts: T0 });
    detector.onToolCall({ tool: "write", inputHash: "B", path: "b.txt", ts: T0 + 1 });
    detector.onToolCall({ tool: "write", inputHash: "A", path: "b.txt", ts: T0 + 2 });
    assert.equal(detector.onToolCall({ tool: "write", inputHash: "A", path: "a.txt", ts: T0 + 3 }).length, 0);
  });

  it("ignores samples without a path", () => {
    const detector = detectors({ detectors: { oscillation: { count: 1 } } });
    detector.onToolCall({ tool: "write", inputHash: "A", path: null, ts: T0 });
    detector.onToolCall({ tool: "write", inputHash: "B", path: null, ts: T0 + 1 });
    assert.equal(detector.onToolCall({ tool: "write", inputHash: "A", path: null, ts: T0 + 2 }).length, 0);
  });

  it("expires alternations outside the window", () => {
    const detector = detectors({ detectors: { oscillation: { count: 1, window_seconds: 5 } } });
    detector.onToolCall({ tool: "write", inputHash: "A", path: "a.txt", ts: T0 });
    detector.onToolCall({ tool: "write", inputHash: "B", path: "a.txt", ts: T0 + 1000 });
    assert.equal(detector.onToolCall({ tool: "write", inputHash: "A", path: "a.txt", ts: T0 + 60_000 }).length, 0);
  });
});
