import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { EXIT_CONFIG, EXIT_INPUT, EXIT_OK, EXIT_TRIGGERED, main } from "../src/cli.js";
import type { SessionReport } from "../src/types.js";
import { removeDir, T0, tempDir } from "./helpers.js";

interface RunResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function run(argv: readonly string[]): Promise<RunResult> {
  let out = "";
  let err = "";
  const code = await main(argv, { out: (text) => (out += text), err: (text) => (err += text) });
  return { code, out, err };
}

function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

const cleanEvents =
  line({ type: "tool.start", sessionID: "s", tool: "read", input: { filePath: "a" }, ts: T0 }) +
  line({ type: "tool.end", sessionID: "s", tool: "read", input: {}, status: "completed", ts: T0 + 10 }) +
  line({ type: "model.context", sessionID: "s", chars: 400, ts: T0 + 20 });

const loopEvents =
  line({ type: "tool.start", sessionID: "s", tool: "read", input: { filePath: "a" }, ts: T0 }) +
  line({ type: "tool.start", sessionID: "s", tool: "read", input: { filePath: "a" }, ts: T0 + 10 });

describe("CLI basics", () => {
  it("prints usage with --help", async () => {
    const result = await run(["--help"]);
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out, /Usage:/);
    assert.match(result.out, /Exit codes:/);
  });

  it("prints usage with --help after a command", async () => {
    const result = await run(["replay", "--help"]);
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out, /Usage:/);
  });

  it("prints the version with --version", async () => {
    const result = await run(["--version"]);
    assert.equal(result.code, EXIT_OK);
    assert.equal(result.out.trim(), "0.1.0");
  });

  it("exits 2 without a command", async () => {
    const result = await run([]);
    assert.equal(result.code, EXIT_INPUT);
    assert.match(result.err, /Usage:/);
  });

  it("exits 2 on an unknown command", async () => {
    const result = await run(["frobnicate"]);
    assert.equal(result.code, EXIT_INPUT);
    assert.match(result.err, /unknown command 'frobnicate'/);
  });

  it("exits 2 on an unknown flag", async () => {
    const result = await run(["doctor", "--turbo"]);
    assert.equal(result.code, EXIT_INPUT);
    assert.match(result.err, /unknown flag '--turbo'/);
  });

  it("rejects a flag without its value", async () => {
    const result = await run(["doctor", "--config"]);
    assert.equal(result.code, EXIT_INPUT);
    assert.match(result.err, /--config requires a value/);
  });
});

describe("doctor", () => {
  it("accepts the defaults", async () => {
    const result = await run(["doctor"]);
    assert.equal(result.code, EXIT_OK);
    assert.match(result.out, /config: defaults — valid/);
    assert.match(result.out, /on_loop: warn/);
    assert.match(result.out, /OK/);
  });

  it("emits machine-readable JSON", async () => {
    const result = await run(["doctor", "--json"]);
    assert.equal(result.code, EXIT_OK);
    const parsed = JSON.parse(result.out) as { ok: boolean; version: string; config: { on_loop: string } };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.version, "0.1.0");
    assert.equal(parsed.config.on_loop, "warn");
  });

  it("exits 1 for an unknown config key", async () => {
    const dir = await tempDir();
    try {
      const configPath = join(dir, "bad.json");
      await writeFile(configPath, JSON.stringify({ budgets: { max_usd: 3 } }), "utf8");
      const result = await run(["doctor", "--config", configPath]);
      assert.equal(result.code, EXIT_CONFIG);
      assert.match(result.err, /unknown key 'max_usd'/);
      assert.match(result.err, /budgets\.max_usd/);
    } finally {
      await removeDir(dir);
    }
  });

  it("exits 1 for malformed JSON", async () => {
    const dir = await tempDir();
    try {
      const configPath = join(dir, "bad.json");
      await writeFile(configPath, "{nope", "utf8");
      const result = await run(["doctor", "--config", configPath]);
      assert.equal(result.code, EXIT_CONFIG);
      assert.match(result.err, /not valid JSON/);
    } finally {
      await removeDir(dir);
    }
  });

  it("exits 1 for a report path that escapes the session directory", async () => {
    const dir = await tempDir();
    try {
      const configPath = join(dir, "bad.json");
      await writeFile(configPath, JSON.stringify({ report: { json: "../escape.json" } }), "utf8");
      const result = await run(["doctor", "--config", configPath]);
      assert.equal(result.code, EXIT_CONFIG);
      assert.match(result.err, /must stay inside the session directory/);
    } finally {
      await removeDir(dir);
    }
  });

  it("exits 1 for a missing config file", async () => {
    const result = await run(["doctor", "--config", "does-not-exist.json"]);
    assert.equal(result.code, EXIT_CONFIG);
    assert.match(result.err, /cannot read config file/);
  });
});

describe("replay", () => {
  it("exits 0 for a clean stream", async () => {
    const dir = await tempDir();
    try {
      const eventsPath = join(dir, "events.jsonl");
      await writeFile(eventsPath, cleanEvents, "utf8");
      const result = await run(["replay", "--events", eventsPath]);
      assert.equal(result.code, EXIT_OK);
      assert.match(result.out, /events: 3, sessions: 1/);
      assert.match(result.out, /no trigger/);
      assert.match(result.out, /tokens_est: 100/);
    } finally {
      await removeDir(dir);
    }
  });

  it("exits 3 when a loop triggers a kill", async () => {
    const dir = await tempDir();
    try {
      const eventsPath = join(dir, "events.jsonl");
      const configPath = join(dir, "config.json");
      await writeFile(eventsPath, loopEvents, "utf8");
      await writeFile(configPath, JSON.stringify({ detectors: { tool_repeat: { threshold: 2 } }, on_loop: "kill" }));
      const result = await run(["replay", "--events", eventsPath, "--config", configPath]);
      assert.equal(result.code, EXIT_TRIGGERED);
      assert.match(result.out, /session s: STOPPED/);
      assert.match(result.out, /loop: tool_repeat/);
    } finally {
      await removeDir(dir);
    }
  });

  it("exits 0 and warns when on_loop=warn", async () => {
    const dir = await tempDir();
    try {
      const eventsPath = join(dir, "events.jsonl");
      const configPath = join(dir, "config.json");
      await writeFile(eventsPath, loopEvents, "utf8");
      await writeFile(configPath, JSON.stringify({ detectors: { tool_repeat: { threshold: 2 } } }));
      const result = await run(["replay", "--events", eventsPath, "--config", configPath]);
      assert.equal(result.code, EXIT_OK);
      assert.match(result.err, /warning: tool_repeat/);
      assert.match(result.out, /no trigger/);
    } finally {
      await removeDir(dir);
    }
  });

  it("reports a dry-run would-kill with exit 3 and no stop", async () => {
    const dir = await tempDir();
    try {
      const eventsPath = join(dir, "events.jsonl");
      const configPath = join(dir, "config.json");
      await writeFile(eventsPath, loopEvents, "utf8");
      await writeFile(configPath, JSON.stringify({ detectors: { tool_repeat: { threshold: 2 } }, on_loop: "kill" }));
      const result = await run(["replay", "--events", eventsPath, "--config", configPath, "--dry-run"]);
      assert.equal(result.code, EXIT_TRIGGERED);
      assert.match(result.out, /DRY RUN/);
      assert.match(result.out, /would kill: loop/);
    } finally {
      await removeDir(dir);
    }
  });

  it("exits 2 for malformed JSON with the line number", async () => {
    const dir = await tempDir();
    try {
      const eventsPath = join(dir, "events.jsonl");
      await writeFile(eventsPath, `${cleanEvents}{"type":\n`, "utf8");
      const result = await run(["replay", "--events", eventsPath]);
      assert.equal(result.code, EXIT_INPUT);
      assert.match(result.err, /line 4 is not valid JSON/);
    } finally {
      await removeDir(dir);
    }
  });

  it("exits 2 for an invalid event with the line number", async () => {
    const dir = await tempDir();
    try {
      const eventsPath = join(dir, "events.jsonl");
      await writeFile(eventsPath, line({ type: "tool.start", sessionID: "", tool: "read", ts: T0 }), "utf8");
      const result = await run(["replay", "--events", eventsPath]);
      assert.equal(result.code, EXIT_INPUT);
      assert.match(result.err, /line 1: sessionID must be/);
    } finally {
      await removeDir(dir);
    }
  });

  it("exits 2 for a missing events file", async () => {
    const result = await run(["replay", "--events", "missing-events.jsonl"]);
    assert.equal(result.code, EXIT_INPUT);
    assert.match(result.err, /cannot read events file/);
  });

  it("requires --events", async () => {
    const result = await run(["replay"]);
    assert.equal(result.code, EXIT_INPUT);
    assert.match(result.err, /replay requires --events/);
  });

  it("prints parseable JSON reports", async () => {
    const dir = await tempDir();
    try {
      const eventsPath = join(dir, "events.jsonl");
      await writeFile(eventsPath, cleanEvents, "utf8");
      const result = await run(["replay", "--events", eventsPath, "--json"]);
      assert.equal(result.code, EXIT_OK);
      const parsed = JSON.parse(result.out) as { reports: SessionReport[] };
      assert.equal(parsed.reports.length, 1);
      assert.equal(parsed.reports[0]?.events.tool, 2);
      assert.equal(parsed.reports[0]?.tokens_est.value, 100);
    } finally {
      await removeDir(dir);
    }
  });

  it("writes a markdown report", async () => {
    const dir = await tempDir();
    try {
      const eventsPath = join(dir, "events.jsonl");
      const markdownPath = join(dir, "nested", "report.md");
      await writeFile(eventsPath, cleanEvents, "utf8");
      const result = await run(["replay", "--events", eventsPath, "--markdown", markdownPath]);
      assert.equal(result.code, EXIT_OK);
      const markdown = await readFile(markdownPath, "utf8");
      assert.match(markdown, /# Budget guard report — s/);
    } finally {
      await removeDir(dir);
    }
  });

  it("keeps JSON output parseable when also writing markdown", async () => {
    const dir = await tempDir();
    try {
      const eventsPath = join(dir, "events.jsonl");
      const markdownPath = join(dir, "report.md");
      await writeFile(eventsPath, cleanEvents, "utf8");
      const result = await run(["replay", "--events", eventsPath, "--json", "--markdown", markdownPath]);
      assert.equal(result.code, EXIT_OK);
      const parsed = JSON.parse(result.out) as { reports: SessionReport[] };
      assert.equal(parsed.reports.length, 1);
      assert.match(result.err, /markdown:/);
      await readFile(markdownPath, "utf8");
    } finally {
      await removeDir(dir);
    }
  });

  it("exits 2 instead of throwing when the markdown target is a directory", async () => {
    const dir = await tempDir();
    try {
      const eventsPath = join(dir, "events.jsonl");
      await writeFile(eventsPath, cleanEvents, "utf8");
      const result = await run(["replay", "--events", eventsPath, "--markdown", dir]);
      assert.equal(result.code, EXIT_INPUT);
      assert.match(result.err, /cannot write markdown report/);
    } finally {
      await removeDir(dir);
    }
  });

  it("ignores blank lines", async () => {
    const dir = await tempDir();
    try {
      const eventsPath = join(dir, "events.jsonl");
      await writeFile(eventsPath, `\n\n${cleanEvents}\n`, "utf8");
      const result = await run(["replay", "--events", eventsPath]);
      assert.equal(result.code, EXIT_OK);
      assert.match(result.out, /events: 3/);
    } finally {
      await removeDir(dir);
    }
  });
});
