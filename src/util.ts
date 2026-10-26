import { createHash } from "node:crypto";

const MAX_PATH_CHARS = 4096;
const MAX_ERROR_CHARS = 200;
const MAX_DEPTH = 64;
const MAX_NODES = 100_000;

export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value, 0, new WeakSet(), { count: 0 })) ?? "null";
}

interface Budget {
  count: number;
}

function normalize(value: unknown, depth: number, stack: WeakSet<object>, budget: Budget): unknown {
  budget.count += 1;
  if (budget.count > MAX_NODES) return "<truncated>";
  if (depth > MAX_DEPTH) return "<max-depth>";
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : normalize(item, depth + 1, stack, budget)));
  }
  if (typeof value === "object" && value !== null) {
    if (stack.has(value)) return "<circular>";
    stack.add(value);
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      out[key] = normalize(item, depth + 1, stack, budget);
    }
    stack.delete(value);
    return out;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

export function hashInput(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

export function normalizeError(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0] ?? "";
  const withoutWindowsPaths = firstLine.replace(/\b[A-Za-z]:\\[^\s"'<>|]+/g, "<path>");
  const withoutPosixPaths = withoutWindowsPaths.replace(/(?:^|[\s"'(])\/(?:[\w.@+-]+\/)+[\w.@+-]+/g, " <path>");
  return withoutPosixPaths.trim().slice(0, MAX_ERROR_CHARS);
}

const PATH_KEYS = ["filePath", "filepath", "file_path", "path", "file"] as const;

export function extractPath(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value !== "" && value.length <= MAX_PATH_CHARS) return value;
  }
  return null;
}
