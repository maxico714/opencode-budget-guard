import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ConfigError, DEFAULT_CONFIG, resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("returns defaults for an empty object", () => {
    const config = resolveConfig({});
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.equal(config.on_loop, "warn");
    assert.equal(config.dry_run, false);
    assert.equal(config.detectors.identical_fail.threshold, 3);
    assert.equal(config.budgets.max_tokens_est, 100_000);
  });

  it("merges partial overrides without dropping sibling defaults", () => {
    const config = resolveConfig({ detectors: { tool_repeat: { threshold: 2 } }, budgets: { max_wall_seconds: 10 } });
    assert.equal(config.detectors.tool_repeat.threshold, 2);
    assert.equal(config.detectors.tool_repeat.window_seconds, DEFAULT_CONFIG.detectors.tool_repeat.window_seconds);
    assert.equal(config.detectors.identical_fail.threshold, 3);
    assert.equal(config.budgets.max_wall_seconds, 10);
    assert.equal(config.budgets.max_tokens_est, 100_000);
  });

  it("accepts threshold 0 and budget 0", () => {
    const config = resolveConfig({
      detectors: { identical_fail: { threshold: 0 }, oscillation: { count: 0 } },
      budgets: { max_tokens_est: 0, max_wall_seconds: 0, max_consecutive_failures: 0 },
    });
    assert.equal(config.detectors.identical_fail.threshold, 0);
    assert.equal(config.budgets.max_tokens_est, 0);
  });

  const rejects: [string, unknown, string][] = [
    ["null config", null, "must be a JSON object"],
    ["array config", [], "must be a JSON object"],
    ["unknown top-level key", { nope: 1 }, "unknown key 'nope'"],
    ["unknown detector", { detectors: { loop: {} } }, "unknown key 'loop'"],
    ["unknown detector key", { detectors: { tool_repeat: { limit: 2 } } }, "unknown key 'limit'"],
    ["unknown budget", { budgets: { max_usd: 2 } }, "unknown key 'max_usd'"],
    ["unknown report key", { report: { xml: "x" } }, "unknown key 'xml'"],
    ["string threshold", { detectors: { tool_repeat: { threshold: "3" } } }, "integer >= 0"],
    ["negative threshold", { detectors: { tool_repeat: { threshold: -1 } } }, "integer >= 0"],
    ["fractional threshold", { detectors: { tool_repeat: { threshold: 1.5 } } }, "integer >= 0"],
    ["zero window", { detectors: { tool_repeat: { window_seconds: 0 } } }, "integer >= 1"],
    ["negative budget", { budgets: { max_tokens_est: -5 } }, "integer >= 0"],
    ["bad on_loop", { on_loop: "explode" }, "must be 'warn' or 'kill'"],
    ["string dry_run", { dry_run: "yes" }, "must be a boolean"],
    ["negative warn repeat", { warn_repeat_seconds: -1 }, "integer >= 0"],
    ["null budget object", { budgets: null }, "must be an object"],
    ["report path number", { report: { json: 7 } }, "non-empty string or null"],
    ["absolute report path", { report: { json: "/tmp/report.json" } }, "must be a relative path"],
    ["empty report path", { report: { markdown: "  " } }, "non-empty string or null"],
  ];

  for (const [name, input, expected] of rejects) {
    it(`rejects ${name}`, () => {
      assert.throws(
        () => resolveConfig(input),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          return true;
        },
      );
    });
  }

  it("reports the path of the failing key", () => {
    assert.throws(
      () => resolveConfig({ detectors: { oscillation: { count: -2 } } }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.path, "detectors.oscillation.count");
        return true;
      },
    );
  });
});
