import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { attach } from "../src/adapter.js";
import type { SessionReport } from "../src/types.js";
import { FakeHost, removeDir, T0, tempDir } from "./helpers.js";

function makeHost(directory: string, options: Record<string, unknown> = {}): FakeHost {
  return new FakeHost(directory, options);
}

describe("attach", () => {
  it("registers the three documented hooks", async () => {
    const dir = await tempDir();
    try {
      const host = makeHost(dir);
      const attached = attach(host, { log: () => {} });
      await attached.ready;
      assert.deepEqual(host.hookNames, ["context", "execute.after", "execute.before"]);
      await attached.cleanup();
    } finally {
      await removeDir(dir);
    }
  });

  it("interrupts the session once when a loop is detected", async () => {
    const dir = await tempDir();
    try {
      const host = makeHost(dir, {
        detectors: { tool_repeat: { threshold: 2 } },
        on_loop: "kill",
        report: { json: "guard.json", markdown: null },
      });
      const logs: string[] = [];
      const attached = attach(host, { now: () => T0, log: (_level, message) => logs.push(message) });
      await attached.ready;
      const event = { tool: "read", sessionID: "s1", input: { filePath: "a" } };
      await host.fire("execute.before", event);
      await host.fire("execute.before", event);
      assert.deepEqual(host.interrupts, ["s1"]);
      assert.ok(logs.some((line) => line.includes("stopping session")));
      await attached.cleanup();
      const report = JSON.parse(await readFile(join(dir, "guard.json"), "utf8")) as SessionReport;
      assert.equal(report.stopped, true);
      assert.equal(report.session_id, "s1");
    } finally {
      await removeDir(dir);
    }
  });

  it("writes the report before returning from the kill decision", async () => {
    const dir = await tempDir();
    try {
      const host = makeHost(dir, {
        detectors: { tool_repeat: { threshold: 1 } },
        on_loop: "kill",
        report: { json: "guard.json", markdown: null },
      });
      const attached = attach(host, { now: () => T0, log: () => {} });
      await attached.ready;
      await host.fire("execute.before", { tool: "read", sessionID: "s", input: {} });
      const report = JSON.parse(await readFile(join(dir, "guard.json"), "utf8")) as SessionReport;
      assert.equal(report.stopped, true);
      await attached.cleanup();
    } finally {
      await removeDir(dir);
    }
  });

  it("does not interrupt a clean session and writes a final report on cleanup", async () => {
    const dir = await tempDir();
    try {
      const host = makeHost(dir, { report: { json: "guard.json", markdown: null } });
      const attached = attach(host, { now: () => T0, log: () => {} });
      await attached.ready;
      await host.fire("execute.before", { tool: "read", sessionID: "s", input: { filePath: "a" } });
      await host.fire("execute.after", { tool: "read", sessionID: "s", input: {}, status: "completed" });
      await host.fire("context", { sessionID: "s", messages: [{ role: "user", content: "hello" }], system: [] });
      assert.deepEqual(host.interrupts, []);
      await attached.cleanup();
      const report = JSON.parse(await readFile(join(dir, "guard.json"), "utf8")) as SessionReport;
      assert.equal(report.stopped, false);
      assert.equal(report.events.tool, 2);
      assert.equal(report.events.model, 1);
      assert.ok(report.tokens_est.value > 0);
    } finally {
      await removeDir(dir);
    }
  });

  it("reports a would-kill in dry-run mode without interrupting", async () => {
    const dir = await tempDir();
    try {
      const host = makeHost(dir, {
        detectors: { tool_repeat: { threshold: 1 } },
        on_loop: "kill",
        dry_run: true,
        report: { json: "guard.json", markdown: null },
      });
      const logs: string[] = [];
      const attached = attach(host, { now: () => T0, log: (_level, message) => logs.push(message) });
      await attached.ready;
      await host.fire("execute.before", { tool: "read", sessionID: "s", input: {} });
      assert.deepEqual(host.interrupts, []);
      assert.ok(logs.some((line) => line.includes("would stop session")));
      await attached.cleanup();
      const report = JSON.parse(await readFile(join(dir, "guard.json"), "utf8")) as SessionReport;
      assert.equal(report.stopped, false);
      assert.equal(report.dry_run, true);
    } finally {
      await removeDir(dir);
    }
  });

  it("disables itself with a logged error on invalid configuration", async () => {
    const dir = await tempDir();
    try {
      const host = makeHost(dir, { on_loop: "explode" });
      const logs: { level: string; message: string }[] = [];
      const attached = attach(host, { log: (level, message) => logs.push({ level, message }) });
      await attached.ready;
      assert.equal(attached.config, null);
      assert.equal(attached.guard, null);
      assert.deepEqual(host.hookNames, []);
      assert.equal(logs[0]?.level, "error");
      assert.match(logs[0]?.message ?? "", /invalid configuration/);
      await attached.cleanup();
    } finally {
      await removeDir(dir);
    }
  });

  it("ignores malformed events instead of throwing", async () => {
    const dir = await tempDir();
    try {
      const host = makeHost(dir);
      const logs: string[] = [];
      const attached = attach(host, { now: () => T0, log: (_level, message) => logs.push(message) });
      await attached.ready;
      await host.fire("execute.before", { tool: "", sessionID: "", input: {} });
      assert.ok(logs.some((line) => line.includes("ignored invalid event")));
      await attached.cleanup();
    } finally {
      await removeDir(dir);
    }
  });

  it("logs a warning when the session was already idle", async () => {
    const dir = await tempDir();
    try {
      const host = makeHost(dir, { detectors: { tool_repeat: { threshold: 1 } }, on_loop: "kill" });
      host.interruptResult = false;
      const logs: string[] = [];
      const attached = attach(host, { now: () => T0, log: (_level, message) => logs.push(message) });
      await attached.ready;
      await host.fire("execute.before", { tool: "read", sessionID: "s", input: {} });
      assert.ok(logs.some((line) => line.includes("already idle")));
      await attached.cleanup();
    } finally {
      await removeDir(dir);
    }
  });

  it("still enforces the token budget for circular context payloads", async () => {
    const dir = await tempDir();
    try {
      const host = makeHost(dir, {
        budgets: { max_tokens_est: 0 },
        report: { json: "guard.json", markdown: null },
      });
      const attached = attach(host, { now: () => T0, log: () => {} });
      await attached.ready;
      const messages: Record<string, unknown> = { role: "user" };
      messages.self = messages;
      await host.fire("context", { sessionID: "s", messages, system: [] });
      assert.deepEqual(host.interrupts, ["s"]);
      await attached.cleanup();
      const report = JSON.parse(await readFile(join(dir, "guard.json"), "utf8")) as SessionReport;
      assert.equal(report.stopped, true);
      assert.ok(report.tokens_est.value > 0);
    } finally {
      await removeDir(dir);
    }
  });

  it("logs an error when interruption fails", async () => {
    const dir = await tempDir();
    try {
      const host = makeHost(dir, { detectors: { tool_repeat: { threshold: 1 } }, on_loop: "kill" });
      host.interruptError = new Error("connection lost");
      const logs: string[] = [];
      const attached = attach(host, { now: () => T0, log: (_level, message) => logs.push(message) });
      await attached.ready;
      await host.fire("execute.before", { tool: "read", sessionID: "s", input: {} });
      assert.ok(logs.some((line) => line.includes("failed to interrupt session: connection lost")));
      await attached.cleanup();
    } finally {
      await removeDir(dir);
    }
  });

  it("reports written paths through the onReport callback", async () => {
    const dir = await tempDir();
    try {
      const host = makeHost(dir, { report: { json: "guard.json", markdown: "guard.md" } });
      const seen: string[][] = [];
      const attached = attach(host, {
        now: () => T0,
        log: () => {},
        onReport: (_report, paths) => seen.push([...paths]),
      });
      await attached.ready;
      await host.fire("execute.before", { tool: "read", sessionID: "s", input: {} });
      await attached.cleanup();
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.length, 2);
      await access(join(dir, "guard.json"));
      await access(join(dir, "guard.md"));
    } finally {
      await removeDir(dir);
    }
  });
});
