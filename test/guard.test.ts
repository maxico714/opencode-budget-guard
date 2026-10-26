import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveConfig } from "../src/config.js";
import { EventError, Guard, validateEvent } from "../src/guard.js";
import { config, modelContext, T0, toolEnd, toolStart } from "./helpers.js";

describe("validateEvent", () => {
  const rejects: [string, unknown, string][] = [
    ["null", null, "event must be a JSON object"],
    ["array", [], "event must be a JSON object"],
    ["missing type", { sessionID: "s", ts: T0 }, "unknown event type"],
    ["bad type", { type: "session.start", sessionID: "s", ts: T0 }, "unknown event type"],
    ["missing session", { type: "tool.start", tool: "read", ts: T0 }, "sessionID must be"],
    ["empty session", { type: "tool.start", sessionID: "", tool: "read", ts: T0 }, "sessionID must be"],
    ["long session", { type: "tool.start", sessionID: "s".repeat(257), tool: "read", ts: T0 }, "longer than 256"],
    ["missing tool", { type: "tool.start", sessionID: "s", ts: T0 }, "tool must be"],
    ["negative ts", { type: "tool.start", sessionID: "s", tool: "read", ts: -1 }, "ts must be"],
    ["float ts", { type: "tool.start", sessionID: "s", tool: "read", ts: 1.5 }, "ts must be"],
    ["string ts", { type: "tool.start", sessionID: "s", tool: "read", ts: "1" }, "ts must be"],
    ["huge ts", { type: "tool.start", sessionID: "s", tool: "read", ts: 9e15 }, "ts must be"],
    ["bad status", { type: "tool.end", sessionID: "s", tool: "read", status: "ok", ts: T0 }, "status must be"],
    [
      "non-string error",
      { type: "tool.end", sessionID: "s", tool: "read", status: "error", error: 3, ts: T0 },
      "error must be",
    ],
    ["negative chars", { type: "model.context", sessionID: "s", chars: -1, ts: T0 }, "chars must be"],
    ["float chars", { type: "model.context", sessionID: "s", chars: 1.5, ts: T0 }, "chars must be"],
  ];

  for (const [name, input, expected] of rejects) {
    it(`rejects ${name}`, () => {
      assert.throws(
        () => validateEvent(input),
        (error: unknown) => {
          assert.ok(error instanceof EventError);
          assert.match(error.message, new RegExp(expected));
          return true;
        },
      );
    });
  }

  it("accepts a completed tool event without an error", () => {
    const event = validateEvent({ type: "tool.end", sessionID: "s", tool: "read", status: "completed", ts: T0 });
    assert.equal(event.type, "tool.end");
  });

  it("accepts an error event with a message", () => {
    const event = validateEvent({
      type: "tool.end",
      sessionID: "s",
      tool: "read",
      status: "error",
      error: "x",
      ts: T0,
    });
    assert.equal(event.type, "tool.end");
    if (event.type === "tool.end") assert.equal(event.error, "x");
  });
});

describe("Guard decisions", () => {
  it("does not trigger on a clean session", () => {
    const guard = new Guard(resolveConfig({}));
    for (let index = 0; index < 5; index += 1) {
      assert.equal(guard.ingest(toolStart("s", "read", { filePath: `f${index}` }, T0 + index)).action, "none");
      assert.equal(guard.ingest(toolEnd("s", "read", {}, T0 + index)).action, "none");
    }
  });

  it("warns on a loop when on_loop=warn and keeps running", () => {
    const guard = new Guard(config({ detectors: { tool_repeat: { threshold: 2 } }, on_loop: "warn" }));
    guard.ingest(toolStart("s", "read", { filePath: "a" }, T0));
    const decision = guard.ingest(toolStart("s", "read", { filePath: "a" }, T0 + 1));
    assert.equal(decision.action, "warn");
    assert.equal(guard.snapshot("s")?.stopped, false);
    assert.equal(guard.ingest(toolStart("s", "read", { filePath: "b" }, T0 + 2)).action, "none");
  });

  it("kills on a loop when on_loop=kill", () => {
    const guard = new Guard(config({ detectors: { tool_repeat: { threshold: 2 } }, on_loop: "kill" }));
    guard.ingest(toolStart("s", "read", { filePath: "a" }, T0));
    const decision = guard.ingest(toolStart("s", "read", { filePath: "a" }, T0 + 1));
    assert.equal(decision.action, "kill");
    if (decision.action !== "kill") return;
    assert.equal(decision.reason, "loop");
    assert.equal(decision.dry_run, false);
    const report = guard.snapshot("s");
    assert.equal(report?.stopped, true);
    assert.match(report?.reason ?? "", /tool_repeat/);
    assert.equal(guard.ingest(toolStart("s", "read", { filePath: "a" }, T0 + 2)).action, "none");
  });

  it("kills on a budget breach even when loops only warn", () => {
    const guard = new Guard(config({ on_loop: "warn", budgets: { max_tokens_est: 10 } }));
    const decision = guard.ingest(modelContext("s", 100, T0));
    assert.equal(decision.action, "kill");
    if (decision.action !== "kill") return;
    assert.equal(decision.reason, "budget");
    assert.equal(decision.breaches[0]?.budget, "max_tokens_est");
  });

  it("reports a would-kill without stopping in dry-run mode", () => {
    const guard = new Guard(config({ detectors: { tool_repeat: { threshold: 2 } }, on_loop: "kill", dry_run: true }));
    guard.ingest(toolStart("s", "read", { filePath: "a" }, T0));
    const decision = guard.ingest(toolStart("s", "read", { filePath: "a" }, T0 + 1));
    assert.equal(decision.action, "kill");
    if (decision.action !== "kill") return;
    assert.equal(decision.dry_run, true);
    const report = guard.snapshot("s");
    assert.equal(report?.stopped, false);
    assert.equal(report?.dry_run, true);
    assert.match(report?.reason ?? "", /^would kill: loop/);
  });

  it("deduplicates repeated warnings within warn_repeat_seconds", () => {
    const guard = new Guard(
      config({ detectors: { tool_repeat: { threshold: 2 } }, on_loop: "warn", warn_repeat_seconds: 60 }),
    );
    guard.ingest(toolStart("s", "read", { filePath: "a" }, T0));
    assert.equal(guard.ingest(toolStart("s", "read", { filePath: "a" }, T0 + 1)).action, "warn");
    assert.equal(guard.ingest(toolStart("s", "read", { filePath: "a" }, T0 + 2)).action, "none");
    assert.equal(guard.ingest(toolStart("s", "read", { filePath: "a" }, T0 + 61_000)).action, "warn");
  });

  it("keeps sessions independent", () => {
    const guard = new Guard(config({ detectors: { tool_repeat: { threshold: 2 } }, on_loop: "kill" }));
    guard.ingest(toolStart("a", "read", {}, T0));
    assert.equal(guard.ingest(toolStart("b", "read", {}, T0 + 1)).action, "none");
    assert.equal(guard.ingest(toolStart("a", "read", {}, T0 + 2)).action, "kill");
  });

  it("builds a report with events, estimates and thresholds", () => {
    const guard = new Guard(config({ budgets: { max_tokens_est: 500 } }));
    guard.ingest(modelContext("s", 400, T0));
    const report = guard.snapshot("s");
    assert.ok(report !== null);
    assert.equal(report?.tokens_est.value, 100);
    assert.equal(report?.tokens_est.source, "estimate");
    assert.equal(report?.events.model, 1);
    assert.equal(report?.duration_s, 0);
    assert.equal(report?.thresholds.budgets.max_tokens_est, 500);
    assert.deepEqual(report?.loops, []);
  });

  it("returns null for an unknown session", () => {
    assert.equal(new Guard(resolveConfig({})).snapshot("missing"), null);
  });

  it("bounds the number of tracked sessions", () => {
    const guard = new Guard(resolveConfig({}));
    for (let index = 0; index < 70; index += 1) guard.ingest(toolStart(`s${index}`, "read", {}, T0 + index));
    assert.equal(guard.snapshotAll().length, 64);
    assert.equal(guard.snapshot("s0"), null);
    assert.equal(guard.snapshot("s69")?.session_id, "s69");
  });

  it("records at most 50 loop entries", () => {
    const guard = new Guard(
      config({
        detectors: { identical_fail: { threshold: 1 } },
        on_loop: "warn",
        budgets: { max_consecutive_failures: 1_000 },
      }),
    );
    for (let index = 0; index < 80; index += 1) {
      guard.ingest(toolEnd("s", "edit", {}, T0 + index, "error", `boom ${index}`));
    }
    assert.equal(guard.snapshot("s")?.loops.length, 50);
  });
});
