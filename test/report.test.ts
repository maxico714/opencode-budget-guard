import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { resolveConfig } from "../src/config.js";
import { Guard } from "../src/guard.js";
import { formatSummary, reportToJson, reportToMarkdown, resolveReportPath, writeReports } from "../src/report.js";
import type { SessionReport } from "../src/types.js";
import { modelContext, removeDir, T0, tempDir, toolEnd, toolStart } from "./helpers.js";

function sampleReport(): SessionReport {
  const guard = new Guard(resolveConfig({ detectors: { tool_repeat: { threshold: 2 } }, on_loop: "kill" }));
  guard.ingest(toolStart("s1", "read", { filePath: "a" }, T0));
  guard.ingest(toolStart("s1", "read", { filePath: "a" }, T0 + 1000));
  const report = guard.snapshot("s1");
  assert.ok(report !== null);
  return report;
}

describe("report rendering", () => {
  it("serializes to stable JSON that round-trips", () => {
    const report = sampleReport();
    const parsed = JSON.parse(reportToJson(report)) as SessionReport;
    assert.deepEqual(parsed, report);
  });

  it("renders markdown with the stop reason and tables", () => {
    const report = sampleReport();
    const markdown = reportToMarkdown(report);
    assert.match(markdown, /# Budget guard report — s1/);
    assert.match(markdown, /Stopped: \*\*yes\*\*/);
    assert.match(markdown, /## Loop detections/);
    assert.match(markdown, /\| tool_repeat \| 2 \|/);
    assert.match(markdown, /not provider billing data/);
  });

  it("renders empty sections as None", () => {
    const guard = new Guard(resolveConfig({}));
    guard.ingest(toolStart("s", "read", {}, T0));
    const report = guard.snapshot("s");
    assert.ok(report !== null);
    const markdown = reportToMarkdown(report);
    assert.match(markdown, /## Budget breaches\n\nNone\./);
  });

  it("formats a human summary", () => {
    const guard = new Guard(resolveConfig({ budgets: { max_tokens_est: 1 } }));
    guard.ingest(modelContext("s", 400, T0));
    const report = guard.snapshot("s");
    assert.ok(report !== null);
    const summary = formatSummary(report);
    assert.match(summary, /session s: STOPPED/);
    assert.match(summary, /tokens_est: 100/);
  });
});

describe("report paths", () => {
  it("rejects paths that escape the base directory", () => {
    assert.throws(() => resolveReportPath("/base", "../escape.json"), /escapes the base directory/);
  });

  it("rejects absolute paths", () => {
    assert.throws(() => resolveReportPath("/base", "/tmp/report.json"), /must be relative/);
  });

  it("writes JSON and markdown atomically, creating directories", async () => {
    const dir = await tempDir();
    try {
      const report = sampleReport();
      const written = await writeReports(dir, { json: "out/report.json", markdown: "out/report.md" }, report);
      assert.equal(written.length, 2);
      const json = await readFile(join(dir, "out", "report.json"), "utf8");
      const markdown = await readFile(join(dir, "out", "report.md"), "utf8");
      assert.equal((JSON.parse(json) as SessionReport).session_id, "s1");
      assert.match(markdown, /# Budget guard report/);
    } finally {
      await removeDir(dir);
    }
  });

  it("writes nothing when both targets are null", async () => {
    const dir = await tempDir();
    try {
      const report = sampleReport();
      assert.deepEqual(await writeReports(dir, { json: null, markdown: null }, report), []);
    } finally {
      await removeDir(dir);
    }
  });

  it("keeps error signatures out of reports", () => {
    const guard = new Guard(resolveConfig({ detectors: { identical_fail: { threshold: 1 } } }));
    guard.ingest(toolEnd("s", "edit", {}, T0, "error", "secret-token-abc failed"));
    const report = guard.snapshot("s");
    assert.ok(report !== null);
    const text = reportToJson(report);
    assert.doesNotMatch(text, /secret-token-abc/);
  });
});
