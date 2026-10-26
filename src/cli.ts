#!/usr/bin/env node
import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { ConfigError, resolveConfig, type GuardConfig } from "./config.js";
import { EventError, Guard } from "./guard.js";
import { formatSummary, reportToMarkdown } from "./report.js";
import type { SessionReport } from "./types.js";
import { VERSION } from "./version.js";

export const EXIT_OK = 0;
export const EXIT_CONFIG = 1;
export const EXIT_INPUT = 2;
export const EXIT_TRIGGERED = 3;

const MAX_LINE_BYTES = 1_048_576;

const FILE_ERROR_CODES = new Set(["ENOENT", "EISDIR", "EACCES", "EPERM", "ELOOP", "EMFILE", "ENFILE"]);

export interface CliIO {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const defaultIO: CliIO = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

const USAGE = `opencode-budget-guard ${VERSION}

Usage:
  opencode-budget-guard doctor [--config <file>] [--json]
  opencode-budget-guard replay --events <file.jsonl> [--config <file>] [--json]
                                     [--markdown <file>] [--dry-run]
  opencode-budget-guard --help
  opencode-budget-guard --version

Commands:
  doctor   Validate the configuration and check that report paths are writable.
  replay   Run the guard over a recorded JSONL event stream and print a report.

Exit codes:
  0  ok (doctor valid; replay finished without a trigger)
  1  configuration error
  2  usage or input error
  3  the guard triggered (or would trigger under --dry-run)

Events (one JSON object per line):
  {"type":"tool.start","sessionID":"s1","tool":"edit","input":{...},"ts":1700000000000}
  {"type":"tool.end","sessionID":"s1","tool":"edit","input":{...},"status":"error","error":"...","ts":...}
  {"type":"model.context","sessionID":"s1","chars":4000,"ts":...}
`;

interface ParsedArgs {
  readonly command: string | null;
  readonly flags: ReadonlyMap<string, string | true>;
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--help" || arg === "-h") {
      flags.set("help", true);
      continue;
    }
    if (arg === "--version" || arg === "-V") {
      flags.set("version", true);
      continue;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const equals = body.indexOf("=");
      if (equals >= 0) {
        flags.set(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(body, next);
        index += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 1) throw new UsageError(`unexpected argument '${positional[1]}'`);
  return { command: positional[0] ?? null, flags };
}

function readFlag(flags: ParsedArgs["flags"], name: string): string | null {
  const value = flags.get(name);
  if (value === undefined) return null;
  if (value === true) throw new UsageError(`--${name} requires a value`);
  return value;
}

const KNOWN_FLAGS = new Set(["help", "version", "config", "events", "json", "markdown", "dry-run"]);

function rejectUnknownFlags(flags: ParsedArgs["flags"]): void {
  for (const key of flags.keys()) {
    if (!KNOWN_FLAGS.has(key)) throw new UsageError(`unknown flag '--${key}'`);
  }
}

async function loadConfig(path: string | null): Promise<{ config: GuardConfig; source: string }> {
  if (path === null) return { config: resolveConfig({}), source: "defaults" };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read config file: ${error instanceof Error ? error.message : String(error)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`config file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { config: resolveConfig(data), source: path };
}

async function existingAncestor(path: string): Promise<string> {
  let current = resolve(path);
  for (;;) {
    try {
      await access(current, constants.F_OK);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

async function checkWritable(target: string): Promise<string | null> {
  try {
    const ancestor = await existingAncestor(target);
    await access(ancestor, constants.W_OK);
    return null;
  } catch (error) {
    return `cannot write '${target}': ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function doctor(flags: ParsedArgs["flags"], io: CliIO): Promise<number> {
  rejectUnknownFlags(flags);
  const json = flags.get("json") === true;
  const source = readFlag(flags, "config");
  let loaded: { config: GuardConfig; source: string };
  try {
    loaded = await loadConfig(source);
  } catch (error) {
    if (error instanceof ConfigError) {
      io.err(`config error: ${error.message}${error.path === "" ? "" : ` (at ${error.path})`}\n`);
      return EXIT_CONFIG;
    }
    throw error;
  }
  const problems: string[] = [];
  for (const target of [loaded.config.report.json, loaded.config.report.markdown]) {
    if (target === null) continue;
    const problem = await checkWritable(resolve(process.cwd(), target));
    if (problem !== null) problems.push(problem);
  }
  if (json) {
    io.out(
      `${JSON.stringify(
        {
          ok: problems.length === 0,
          version: VERSION,
          source: loaded.source,
          node: process.version,
          config: loaded.config,
          problems,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const detectors = loaded.config.detectors;
    io.out(`opencode-budget-guard ${VERSION} doctor\n`);
    io.out(`config: ${loaded.source} — valid\n`);
    io.out(`node: ${process.version}\n`);
    io.out(
      `detectors: identical_fail=${state(detectors.identical_fail)} tool_repeat=${state(detectors.tool_repeat)} ` +
        `oscillation=${state(detectors.oscillation)}\n`,
    );
    io.out(
      `budgets: max_tokens_est=${loaded.config.budgets.max_tokens_est} ` +
        `max_wall_seconds=${loaded.config.budgets.max_wall_seconds} ` +
        `max_consecutive_failures=${loaded.config.budgets.max_consecutive_failures}\n`,
    );
    io.out(`on_loop: ${loaded.config.on_loop}${loaded.config.dry_run ? " (dry_run)" : ""}\n`);
    io.out(`report: json=${loaded.config.report.json ?? "off"} markdown=${loaded.config.report.markdown ?? "off"}\n`);
    for (const problem of problems) io.err(`warning: ${problem}\n`);
    io.out(problems.length === 0 ? "OK\n" : "OK (with warnings)\n");
  }
  return EXIT_OK;
}

function state(detector: { enabled: boolean; threshold?: number; count?: number; window_seconds: number }): string {
  if (!detector.enabled) return "off";
  const limit = detector.threshold ?? detector.count ?? 0;
  return `on(${limit}/${detector.window_seconds}s)`;
}

interface ReplayResult {
  readonly reports: readonly SessionReport[];
  readonly triggered: boolean;
  readonly events: number;
}

async function replayEvents(eventsPath: string, config: GuardConfig, io: CliIO): Promise<ReplayResult> {
  const guard = new Guard(config);
  let triggered = false;
  let events = 0;
  const stream = createReadStream(eventsPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim() === "") continue;
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        throw new UsageError(`line ${lineNumber} exceeds ${MAX_LINE_BYTES} bytes`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new UsageError(
          `line ${lineNumber} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let decision;
      try {
        decision = guard.ingest(parsed);
      } catch (error) {
        if (error instanceof EventError) throw new UsageError(`line ${lineNumber}: ${error.message}`);
        throw error;
      }
      events += 1;
      if (decision.action === "kill") triggered = true;
      if (decision.action === "warn") {
        for (const hit of decision.hits) io.err(`warning: ${hit.detector}: ${hit.detail}\n`);
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return { reports: guard.snapshotAll(), triggered, events };
}

async function replay(flags: ParsedArgs["flags"], io: CliIO): Promise<number> {
  rejectUnknownFlags(flags);
  const eventsPath = readFlag(flags, "events");
  if (eventsPath === null) throw new UsageError("replay requires --events <file.jsonl>");
  const json = flags.get("json") === true;
  const markdownTarget = readFlag(flags, "markdown");
  const dryRun = flags.get("dry-run") === true;
  let loaded: { config: GuardConfig; source: string };
  try {
    loaded = await loadConfig(readFlag(flags, "config"));
  } catch (error) {
    if (error instanceof ConfigError) {
      io.err(`config error: ${error.message}${error.path === "" ? "" : ` (at ${error.path})`}\n`);
      return EXIT_CONFIG;
    }
    throw error;
  }
  const config: GuardConfig = dryRun ? { ...loaded.config, dry_run: true } : loaded.config;
  let result: ReplayResult;
  try {
    result = await replayEvents(eventsPath, config, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`input error: ${error.message}\n`);
      return EXIT_INPUT;
    }
    if (error instanceof ConfigError) {
      io.err(`config error: ${error.message}\n`);
      return EXIT_CONFIG;
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && FILE_ERROR_CODES.has(code)) {
      io.err(`input error: cannot read events file '${eventsPath}' (${code})\n`);
      return EXIT_INPUT;
    }
    throw error;
  }

  if (json) {
    io.out(`${JSON.stringify({ schema_version: "1", reports: result.reports }, null, 2)}\n`);
  } else {
    io.out(`config: ${loaded.source}\n`);
    io.out(`events: ${result.events}, sessions: ${result.reports.length}\n`);
    for (const report of result.reports) io.out(formatSummary(report));
    io.out(result.triggered ? "guard triggered\n" : "no trigger\n");
  }
  if (markdownTarget !== null) {
    const target = resolve(process.cwd(), markdownTarget);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, result.reports.map(reportToMarkdown).join("\n"), "utf8");
    io.out(`markdown: ${target}\n`);
  }
  return result.triggered ? EXIT_TRIGGERED : EXIT_OK;
}

export async function main(argv: readonly string[], io: CliIO = defaultIO): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`usage error: ${error.message}\n\n${USAGE}`);
      return EXIT_INPUT;
    }
    throw error;
  }
  if (parsed.flags.get("help") === true && parsed.command === null) {
    io.out(USAGE);
    return EXIT_OK;
  }
  if (parsed.flags.get("version") === true) {
    io.out(`${VERSION}\n`);
    return EXIT_OK;
  }
  try {
    switch (parsed.command) {
      case null:
        io.err(USAGE);
        return EXIT_INPUT;
      case "doctor":
        return await doctor(parsed.flags, io);
      case "replay":
        return await replay(parsed.flags, io);
      default:
        throw new UsageError(`unknown command '${parsed.command}'`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`usage error: ${error.message}\n\n${USAGE}`);
      return EXIT_INPUT;
    }
    throw error;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv.slice(2));
}
