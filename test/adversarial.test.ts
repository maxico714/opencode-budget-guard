import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

import { EXIT_INPUT, EXIT_OK, EXIT_TRIGGERED, main } from "../src/cli.js";
import { Guard } from "../src/guard.js";
import { extractPath, hashInput, normalizeError, stableStringify } from "../src/util.js";
import { config, modelContext, removeDir, T0, tempDir, toolStart } from "./helpers.js";

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

describe("hostile tool inputs", () => {
  it("hashes a DAG bomb in bounded time", () => {
    let node: unknown = { leaf: true };
    for (let depth = 0; depth < 40; depth += 1) node = { a: node, b: node };
    const started = Date.now();
    const hash = hashInput(node);
    assert.match(hash, /^[0-9a-f]{16}$/);
    assert.ok(Date.now() - started < 2_000, "hashing a shared-reference bomb must stay fast");
  });

  it("hashes a 5,000-level chain without overflowing the stack", () => {
    let node: unknown = { leaf: true };
    for (let depth = 0; depth < 5_000; depth += 1) node = { next: node };
    assert.match(hashInput(node), /^[0-9a-f]{16}$/);
    assert.match(stableStringify(node), /<max-depth>/);
  });

  it("marks circular references instead of throwing", () => {
    const record: Record<string, unknown> = { filePath: "a.ts" };
    record.self = record;
    assert.match(stableStringify(record), /<circular>/);
    assert.equal(hashInput(record), hashInput(record));
  });

  it("keeps key order stable for objects built in a different order", () => {
    assert.equal(hashInput({ b: 1, a: 2 }), hashInput({ a: 2, b: 1 }));
  });

  it("hashes multi-megabyte strings without corrupting the digest", () => {
    const big = "x".repeat(4 * 1024 * 1024);
    assert.notEqual(hashInput({ big }), hashInput({ big: `${big}y` }));
  });

  it("handles unicode, control characters and lone surrogates", () => {
    const input = { text: "emoji \u{1f600} nul \u0000 rtl \u202e lone \ud800" };
    assert.match(hashInput(input), /^[0-9a-f]{16}$/);
  });

  it("ignores functions, symbols and undefined values", () => {
    assert.equal(stableStringify({ a: 1, b: undefined, c: () => 1, d: Symbol("x") }), '{"a":1}');
  });

  it("maps non-finite numbers to null instead of invalid JSON", () => {
    assert.equal(stableStringify({ a: Number.NaN, b: Number.POSITIVE_INFINITY }), '{"a":null,"b":null}');
  });
});

describe("error normalization", () => {
  it("strips Windows paths", () => {
    assert.equal(normalizeError("ENOENT: C:\\project\\src\\app.ts missing"), "ENOENT: <path> missing");
  });

  it("strips POSIX paths", () => {
    assert.equal(normalizeError("ENOENT: /home/user/src/app.ts missing"), "ENOENT: <path> missing");
  });

  it("keeps only the first line of a multi-line stack", () => {
    assert.equal(normalizeError("Error: boom\n    at foo (/srv/app.js:1:1)"), "Error: boom");
  });

  it("truncates runaway messages to 200 characters", () => {
    assert.equal(normalizeError("e".repeat(5_000)).length, 200);
  });

  it("keeps distinct errors distinct", () => {
    assert.notEqual(normalizeError("EACCES denied"), normalizeError("ENOENT missing"));
  });
});

describe("path extraction", () => {
  it("accepts the documented key spellings", () => {
    for (const key of ["filePath", "filepath", "file_path", "path", "file"]) {
      assert.equal(extractPath({ [key]: "src/a.ts" }), "src/a.ts");
    }
  });

  it("rejects non-objects, arrays, empty strings and oversized paths", () => {
    assert.equal(extractPath(null), null);
    assert.equal(extractPath("src/a.ts"), null);
    assert.equal(extractPath(["src/a.ts"]), null);
    assert.equal(extractPath({ filePath: "" }), null);
    assert.equal(extractPath({ filePath: 42 }), null);
    assert.equal(extractPath({ filePath: "a".repeat(4097) }), null);
  });
});

describe("hostile event streams", () => {
  it("replays 20,000 events with bounded per-session state", async () => {
    const dir = await tempDir("guard-huge-");
    try {
      const parts: string[] = [];
      for (let index = 0; index < 10_000; index += 1) {
        parts.push(
          line({ type: "tool.start", sessionID: "s", tool: "read", input: { filePath: `f${index}` }, ts: T0 + index }),
        );
        parts.push(
          line({ type: "tool.end", sessionID: "s", tool: "read", input: {}, status: "completed", ts: T0 + index }),
        );
      }
      const events = join(dir, "huge.jsonl");
      await writeFile(events, parts.join(""), "utf8");
      const started = Date.now();
      const result = await run(["replay", "--events", events, "--json"]);
      assert.equal(result.code, EXIT_OK);
      assert.ok(Date.now() - started < 60_000, "20k events must replay in under a minute");
      const payload = JSON.parse(result.out) as { reports: { events: { tool: number }; loops: unknown[] }[] };
      assert.equal(payload.reports[0]?.events.tool, 20_000);
      assert.equal(payload.reports[0]?.loops.length, 0);
    } finally {
      await removeDir(dir);
    }
  });

  it("rejects a line larger than 1 MiB", async () => {
    const dir = await tempDir("guard-line-");
    try {
      const events = join(dir, "big.jsonl");
      await writeFile(events, `${"y".repeat(1_048_577)}\n`, "utf8");
      const result = await run(["replay", "--events", events]);
      assert.equal(result.code, EXIT_INPUT);
      assert.match(result.err, /line 1 exceeds 1048576 bytes/);
    } finally {
      await removeDir(dir);
    }
  });

  it("reports a directory as unreadable input instead of crashing", async () => {
    const dir = await tempDir("guard-dir-");
    try {
      const result = await run(["replay", "--events", dir]);
      assert.equal(result.code, EXIT_INPUT);
      assert.match(result.err, /cannot read events file/);
    } finally {
      await removeDir(dir);
    }
  });

  it("rejects invalid UTF-8 without throwing", async () => {
    const dir = await tempDir("guard-bytes-");
    try {
      const events = join(dir, "bytes.jsonl");
      await writeFile(events, Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]));
      const result = await run(["replay", "--events", events]);
      assert.equal(result.code, EXIT_INPUT);
      assert.match(result.err, /line 1 is not valid UTF-8/);
    } finally {
      await removeDir(dir);
    }
  });

  it("rejects invalid UTF-8 inside a JSON string instead of replacing it", async () => {
    const dir = await tempDir("guard-bytes-string-");
    try {
      const events = join(dir, "bytes.jsonl");
      const prefix = Buffer.from('{"type":"tool.start","sessionID":"s', "utf8");
      const suffix = Buffer.from(`","tool":"read","input":{},"ts":${T0}}\n`, "utf8");
      await writeFile(events, Buffer.concat([prefix, Buffer.from([0xff]), suffix]));
      const result = await run(["replay", "--events", events]);
      assert.equal(result.code, EXIT_INPUT);
      assert.match(result.err, /line 1 is not valid UTF-8/);
    } finally {
      await removeDir(dir);
    }
  });

  it("kills immediately when a detector threshold is zero", async () => {
    const dir = await tempDir("guard-zero-");
    try {
      const events = join(dir, "events.jsonl");
      await writeFile(events, line({ type: "tool.start", sessionID: "s", tool: "read", input: {}, ts: T0 }), "utf8");
      const configPath = join(dir, "config.json");
      await writeFile(
        configPath,
        JSON.stringify({ detectors: { tool_repeat: { threshold: 0 } }, on_loop: "kill" }),
        "utf8",
      );
      const result = await run(["replay", "--events", events, "--config", configPath, "--json"]);
      assert.equal(result.code, EXIT_TRIGGERED);
      const payload = JSON.parse(result.out) as { reports: { reason: string | null; stopped: boolean }[] };
      assert.equal(payload.reports[0]?.stopped, true);
      assert.match(payload.reports[0]?.reason ?? "", /tool_repeat/);
    } finally {
      await removeDir(dir);
    }
  });

  it("kills on the first context event when the token budget is zero", async () => {
    const dir = await tempDir("guard-budget-");
    try {
      const events = join(dir, "events.jsonl");
      await writeFile(events, line({ type: "model.context", sessionID: "s", chars: 4, ts: T0 }), "utf8");
      const configPath = join(dir, "config.json");
      await writeFile(configPath, JSON.stringify({ budgets: { max_tokens_est: 0 } }), "utf8");
      const result = await run(["replay", "--events", events, "--config", configPath, "--json"]);
      assert.equal(result.code, EXIT_TRIGGERED);
      const payload = JSON.parse(result.out) as {
        reports: { stopped: boolean; budget_breaches: { budget: string }[] }[];
      };
      assert.equal(payload.reports[0]?.stopped, true);
      assert.equal(payload.reports[0]?.budget_breaches[0]?.budget, "max_tokens_est");
    } finally {
      await removeDir(dir);
    }
  });

  it("keeps interleaved sessions independent in one stream", async () => {
    const dir = await tempDir("guard-mixed-");
    try {
      const events = join(dir, "events.jsonl");
      const lines = [
        line({ type: "tool.start", sessionID: "a", tool: "read", input: { filePath: "x" }, ts: T0 }),
        line({ type: "tool.start", sessionID: "b", tool: "read", input: { filePath: "x" }, ts: T0 + 1 }),
        line({ type: "tool.start", sessionID: "a", tool: "read", input: { filePath: "x" }, ts: T0 + 2 }),
      ];
      await writeFile(events, lines.join(""), "utf8");
      const configPath = join(dir, "config.json");
      await writeFile(
        configPath,
        JSON.stringify({ detectors: { tool_repeat: { threshold: 2 } }, on_loop: "kill" }),
        "utf8",
      );
      const result = await run(["replay", "--events", events, "--config", configPath, "--json"]);
      assert.equal(result.code, EXIT_TRIGGERED);
      const payload = JSON.parse(result.out) as { reports: { session_id: string; stopped: boolean }[] };
      const byID = new Map(payload.reports.map((report) => [report.session_id, report.stopped]));
      assert.equal(byID.get("a"), true);
      assert.equal(byID.get("b"), false);
    } finally {
      await removeDir(dir);
    }
  });

  it("stays bounded when one tool repeats for a long time", () => {
    const guard = new Guard(config({ detectors: { tool_repeat: { threshold: 3 } } }));
    for (let index = 0; index < 50_000; index += 1) {
      guard.ingest(toolStart("s", "read", { filePath: "a.ts" }, T0 + index));
      guard.ingest(modelContext("s", 4, T0 + index));
    }
    const report = guard.snapshot("s");
    assert.equal(report?.loops.length, 50);
    assert.equal(report?.events.model, 50_000);
  });
});
