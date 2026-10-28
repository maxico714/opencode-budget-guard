import { isAbsolute, normalize, sep } from "node:path";

export interface DetectorConfig {
  readonly enabled: boolean;
  readonly threshold: number;
  readonly window_seconds: number;
}

export interface OscillationConfig {
  readonly enabled: boolean;
  readonly count: number;
  readonly window_seconds: number;
}

export interface BudgetsConfig {
  readonly max_tokens_est: number;
  readonly max_wall_seconds: number;
  readonly max_consecutive_failures: number;
}

export interface ReportConfig {
  readonly json: string | null;
  readonly markdown: string | null;
}

export interface GuardConfig {
  readonly detectors: {
    readonly identical_fail: DetectorConfig;
    readonly tool_repeat: DetectorConfig;
    readonly oscillation: OscillationConfig;
  };
  readonly budgets: BudgetsConfig;
  readonly on_loop: "warn" | "kill";
  readonly dry_run: boolean;
  readonly warn_repeat_seconds: number;
  readonly report: ReportConfig;
}

export const DEFAULT_CONFIG: GuardConfig = {
  detectors: {
    identical_fail: { enabled: true, threshold: 3, window_seconds: 300 },
    tool_repeat: { enabled: true, threshold: 5, window_seconds: 120 },
    oscillation: { enabled: true, count: 2, window_seconds: 60 },
  },
  budgets: { max_tokens_est: 100_000, max_wall_seconds: 3600, max_consecutive_failures: 5 },
  on_loop: "warn",
  dry_run: false,
  warn_repeat_seconds: 60,
  report: { json: ".budget-guard/report.json", markdown: ".budget-guard/report.md" },
};

export class ConfigError extends Error {
  readonly code = "E_CONFIG";
  readonly path: string;

  constructor(message: string, path = "") {
    super(message);
    this.name = "ConfigError";
    this.path = path;
  }
}

type Json = unknown;

function isPlainObject(value: Json): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(value: Record<string, Json>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ConfigError(`unknown key '${key}'`, path === "" ? key : `${path}.${key}`);
    }
  }
}

function readBoolean(value: Json, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ConfigError("must be a boolean", path);
  return value;
}

function readNonNegativeInteger(value: Json, fallback: number, path: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ConfigError("must be an integer >= 0", path);
  }
  return value;
}

function readPositiveInteger(value: Json, fallback: number, path: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ConfigError("must be an integer >= 1", path);
  }
  return value;
}

function readDetector(value: Json, fallback: DetectorConfig, path: string): DetectorConfig {
  if (value === undefined) return fallback;
  if (!isPlainObject(value)) throw new ConfigError("must be an object", path);
  rejectUnknown(value, ["enabled", "threshold", "window_seconds"], path);
  return {
    enabled: readBoolean(value.enabled, fallback.enabled, `${path}.enabled`),
    threshold: readNonNegativeInteger(value.threshold, fallback.threshold, `${path}.threshold`),
    window_seconds: readPositiveInteger(value.window_seconds, fallback.window_seconds, `${path}.window_seconds`),
  };
}

function readOscillation(value: Json, fallback: OscillationConfig, path: string): OscillationConfig {
  if (value === undefined) return fallback;
  if (!isPlainObject(value)) throw new ConfigError("must be an object", path);
  rejectUnknown(value, ["enabled", "count", "window_seconds"], path);
  return {
    enabled: readBoolean(value.enabled, fallback.enabled, `${path}.enabled`),
    count: readNonNegativeInteger(value.count, fallback.count, `${path}.count`),
    window_seconds: readPositiveInteger(value.window_seconds, fallback.window_seconds, `${path}.window_seconds`),
  };
}

function readBudgets(value: Json, fallback: BudgetsConfig, path: string): BudgetsConfig {
  if (value === undefined) return fallback;
  if (!isPlainObject(value)) throw new ConfigError("must be an object", path);
  rejectUnknown(value, ["max_tokens_est", "max_wall_seconds", "max_consecutive_failures"], path);
  return {
    max_tokens_est: readNonNegativeInteger(value.max_tokens_est, fallback.max_tokens_est, `${path}.max_tokens_est`),
    max_wall_seconds: readNonNegativeInteger(
      value.max_wall_seconds,
      fallback.max_wall_seconds,
      `${path}.max_wall_seconds`,
    ),
    max_consecutive_failures: readNonNegativeInteger(
      value.max_consecutive_failures,
      fallback.max_consecutive_failures,
      `${path}.max_consecutive_failures`,
    ),
  };
}

function readReport(value: Json, fallback: ReportConfig, path: string): ReportConfig {
  if (value === undefined) return fallback;
  if (!isPlainObject(value)) throw new ConfigError("must be an object", path);
  rejectUnknown(value, ["json", "markdown"], path);
  const readPath = (item: Json, previous: string | null, itemPath: string): string | null => {
    if (item === undefined) return previous;
    if (item === null) return null;
    if (typeof item !== "string" || item.trim() === "") {
      throw new ConfigError("must be a non-empty string or null", itemPath);
    }
    if (isAbsolute(item)) throw new ConfigError("must be a relative path", itemPath);
    const normalized = normalize(item);
    if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`)) {
      throw new ConfigError("must stay inside the session directory", itemPath);
    }
    return item;
  };
  return {
    json: readPath(value.json, fallback.json, `${path}.json`),
    markdown: readPath(value.markdown, fallback.markdown, `${path}.markdown`),
  };
}

export function resolveConfig(input: Json = {}): GuardConfig {
  if (!isPlainObject(input)) throw new ConfigError("must be a JSON object", "");
  rejectUnknown(input, ["detectors", "budgets", "on_loop", "dry_run", "warn_repeat_seconds", "report"], "");
  const detectors = input.detectors;
  if (detectors !== undefined && !isPlainObject(detectors)) {
    throw new ConfigError("must be an object", "detectors");
  }
  const detectorObject = detectors ?? {};
  rejectUnknown(detectorObject, ["identical_fail", "tool_repeat", "oscillation"], "detectors");
  const onLoop = input.on_loop;
  if (onLoop !== undefined && onLoop !== "warn" && onLoop !== "kill") {
    throw new ConfigError("must be 'warn' or 'kill'", "on_loop");
  }
  return {
    detectors: {
      identical_fail: readDetector(
        detectorObject.identical_fail,
        DEFAULT_CONFIG.detectors.identical_fail,
        "detectors.identical_fail",
      ),
      tool_repeat: readDetector(
        detectorObject.tool_repeat,
        DEFAULT_CONFIG.detectors.tool_repeat,
        "detectors.tool_repeat",
      ),
      oscillation: readOscillation(
        detectorObject.oscillation,
        DEFAULT_CONFIG.detectors.oscillation,
        "detectors.oscillation",
      ),
    },
    budgets: readBudgets(input.budgets, DEFAULT_CONFIG.budgets, "budgets"),
    on_loop: onLoop ?? DEFAULT_CONFIG.on_loop,
    dry_run: readBoolean(input.dry_run, DEFAULT_CONFIG.dry_run, "dry_run"),
    warn_repeat_seconds: readNonNegativeInteger(
      input.warn_repeat_seconds,
      DEFAULT_CONFIG.warn_repeat_seconds,
      "warn_repeat_seconds",
    ),
    report: readReport(input.report, DEFAULT_CONFIG.report, "report"),
  };
}
