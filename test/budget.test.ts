import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BudgetTracker } from "../src/budget.js";
import { resolveConfig } from "../src/config.js";
import { modelContext, T0, toolEnd, toolStart } from "./helpers.js";

describe("BudgetTracker", () => {
  it("estimates tokens as ceil(chars/4) and sums model calls", () => {
    const tracker = new BudgetTracker(resolveConfig({}).budgets, T0);
    tracker.observe(modelContext("s", 4000, T0 + 1));
    tracker.observe(modelContext("s", 2, T0 + 2));
    assert.equal(tracker.snapshot().tokens_est, 1001);
  });

  it("breaches max_tokens_est only when the limit is exceeded", () => {
    const tracker = new BudgetTracker(resolveConfig({ budgets: { max_tokens_est: 100 } }).budgets, T0);
    assert.deepEqual(tracker.observe(modelContext("s", 400, T0 + 1)), []);
    const breaches = tracker.observe(modelContext("s", 4, T0 + 2));
    assert.equal(breaches.length, 1);
    assert.equal(breaches[0]?.budget, "max_tokens_est");
    assert.equal(breaches[0]?.observed, 101);
  });

  it("breaches max_tokens_est=0 on the first non-empty call", () => {
    const tracker = new BudgetTracker(resolveConfig({ budgets: { max_tokens_est: 0 } }).budgets, T0);
    assert.equal(tracker.observe(modelContext("s", 4, T0 + 1))[0]?.budget, "max_tokens_est");
  });

  it("tracks consecutive failures and resets on success", () => {
    const tracker = new BudgetTracker(resolveConfig({ budgets: { max_consecutive_failures: 2 } }).budgets, T0);
    tracker.observe(toolEnd("s", "edit", {}, T0 + 1, "error", "boom"));
    assert.deepEqual(tracker.observe(toolEnd("s", "edit", {}, T0 + 2, "error", "boom")), []);
    const breaches = tracker.observe(toolEnd("s", "edit", {}, T0 + 3, "error", "boom"));
    assert.equal(breaches[0]?.budget, "max_consecutive_failures");
    assert.equal(breaches[0]?.observed, 3);
    tracker.observe(toolEnd("s", "edit", {}, T0 + 4, "completed"));
    assert.equal(tracker.snapshot().consecutive_failures, 0);
  });

  it("breaches max_wall_seconds as time advances", () => {
    const tracker = new BudgetTracker(resolveConfig({ budgets: { max_wall_seconds: 10 } }).budgets, T0);
    assert.deepEqual(tracker.observe(toolStart("s", "read", {}, T0)), []);
    const breaches = tracker.observe(toolStart("s", "read", {}, T0 + 10_001));
    assert.equal(breaches[0]?.budget, "max_wall_seconds");
    assert.equal(breaches[0]?.observed, 10.001);
  });

  it("counts tool and model events", () => {
    const tracker = new BudgetTracker(resolveConfig({}).budgets, T0);
    tracker.observe(toolStart("s", "read", {}, T0 + 1));
    tracker.observe(toolEnd("s", "read", {}, T0 + 2));
    tracker.observe(modelContext("s", 40, T0 + 3));
    assert.deepEqual(tracker.snapshot(), {
      tokens_est: 10,
      wall_seconds: 0.003,
      consecutive_failures: 0,
      tool_events: 2,
      model_events: 1,
    });
  });
});
