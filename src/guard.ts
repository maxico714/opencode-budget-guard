import { BudgetTracker } from "./budget.js";
import type { GuardConfig } from "./config.js";
import { Detectors } from "./detectors.js";
import type { BudgetBreach, Decision, DetectorHit, GuardEvent, SessionReport } from "./types.js";
import { extractPath, hashInput, normalizeError } from "./util.js";
import { BoundedMap } from "./window.js";

const MAX_SESSIONS = 64;
const MAX_LOG_ENTRIES = 50;
const MAX_TS = 8_640_000_000_000_000;

export class EventError extends Error {
  readonly code = "E_EVENT";

  constructor(message: string) {
    super(message);
    this.name = "EventError";
  }
}

interface LoopEntry {
  readonly detector: DetectorHit["detector"];
  readonly detail: string;
  readonly ts: number;
  readonly count: number;
}

interface WarnEntry {
  readonly detector: DetectorHit["detector"];
  readonly detail: string;
  readonly ts: number;
}

interface SessionState {
  readonly id: string;
  readonly startTs: number;
  lastTs: number;
  readonly detectors: Detectors;
  readonly budgets: BudgetTracker;
  stopped: boolean;
  triggered: boolean;
  reason: string | null;
  readonly loops: LoopEntry[];
  readonly breaches: BudgetBreach[];
  readonly warnings: WarnEntry[];
  readonly lastWarn: BoundedMap<number>;
}

function requireString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EventError(`${field} must be a non-empty string`);
  }
  if (value.length > maxLength) throw new EventError(`${field} is longer than ${maxLength} characters`);
  return value;
}

function requireTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_TS) {
    throw new EventError("ts must be an integer millisecond timestamp");
  }
  return value;
}

export function validateEvent(value: unknown): GuardEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EventError("event must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type !== "tool.start" && type !== "tool.end" && type !== "model.context") {
    throw new EventError(`unknown event type '${String(type)}'`);
  }
  const sessionID = requireString(record.sessionID, "sessionID", 256);
  const ts = requireTimestamp(record.ts);

  if (type === "model.context") {
    const chars = record.chars;
    if (typeof chars !== "number" || !Number.isInteger(chars) || chars < 0) {
      throw new EventError("chars must be an integer >= 0");
    }
    return { type, sessionID, chars, ts };
  }

  const tool = requireString(record.tool, "tool", 200);
  const input = record.input;
  if (type === "tool.start") return { type, sessionID, tool, input, ts };

  const status = record.status;
  if (status !== "completed" && status !== "error") {
    throw new EventError("status must be 'completed' or 'error'");
  }
  const rawError = record.error;
  if (rawError !== undefined && typeof rawError !== "string") {
    throw new EventError("error must be a string when present");
  }
  const error = typeof rawError === "string" ? rawError : undefined;
  if (status === "completed") return { type, sessionID, tool, input, status, ts };
  if (error === undefined) return { type, sessionID, tool, input, status, ts };
  return { type, sessionID, tool, input, status, error, ts };
}

function describeKill(reason: "loop" | "budget", hits: readonly DetectorHit[], breaches: readonly BudgetBreach[]) {
  if (reason === "budget") {
    return `budget: ${breaches.map((item) => `${item.budget}=${item.observed} > ${item.limit}`).join(", ")}`;
  }
  return `loop: ${hits.map((item) => `${item.detector} (${item.detail})`).join(", ")}`;
}

export class Guard {
  private readonly sessions = new BoundedMap<SessionState>(MAX_SESSIONS);

  constructor(readonly config: GuardConfig) {}

  ingest(raw: unknown): Decision {
    const event = validateEvent(raw);
    const state = this.sessions.get(event.sessionID) ?? this.createSession(event.sessionID, event.ts);
    if (state.stopped || state.triggered) return { action: "none" };
    state.lastTs = Math.max(state.lastTs, event.ts);

    const hits: DetectorHit[] = [];
    if (event.type === "tool.start") {
      hits.push(
        ...state.detectors.onToolCall({
          tool: event.tool,
          inputHash: hashInput(event.input),
          path: extractPath(event.input),
          ts: event.ts,
        }),
      );
    }
    if (event.type === "tool.end" && event.status === "error") {
      hits.push(
        ...state.detectors.onToolFailure({
          tool: event.tool,
          errorSignature: normalizeError(event.error ?? "unknown error"),
          ts: event.ts,
        }),
      );
    }

    const breaches = state.budgets
      .observe(event)
      .filter((breach) => !state.breaches.some((item) => item.budget === breach.budget));

    if (breaches.length > 0) {
      this.recordBreaches(state, breaches);
      return this.trigger(state, "budget", [], breaches);
    }
    if (hits.length === 0) return { action: "none" };

    this.recordLoops(state, hits);
    if (this.config.on_loop === "kill") return this.trigger(state, "loop", hits, []);

    const emitted = hits.filter((hit) => this.shouldWarn(state, hit));
    if (emitted.length === 0) return { action: "none" };
    for (const hit of emitted) {
      pushBoundedEntry(state.warnings, { detector: hit.detector, detail: hit.detail, ts: hit.ts });
      state.lastWarn.set(`${hit.detector}\u0000${hit.key}`, hit.ts);
    }
    return { action: "warn", hits: emitted };
  }

  snapshot(sessionID: string): SessionReport | null {
    const state = this.sessions.get(sessionID);
    return state === undefined ? null : this.buildReport(state);
  }

  snapshotAll(): SessionReport[] {
    return this.sessions.entries().map(([, state]) => this.buildReport(state));
  }

  private createSession(id: string, ts: number): SessionState {
    const state: SessionState = {
      id,
      startTs: ts,
      lastTs: ts,
      detectors: new Detectors(this.config.detectors),
      budgets: new BudgetTracker(this.config.budgets, ts),
      stopped: false,
      triggered: false,
      reason: null,
      loops: [],
      breaches: [],
      warnings: [],
      lastWarn: new BoundedMap<number>(),
    };
    this.sessions.set(id, state);
    return state;
  }

  private shouldWarn(state: SessionState, hit: DetectorHit): boolean {
    const key = `${hit.detector}\u0000${hit.key}`;
    const previous = state.lastWarn.get(key);
    if (previous === undefined) return true;
    return hit.ts - previous >= this.config.warn_repeat_seconds * 1000;
  }

  private recordLoops(state: SessionState, hits: readonly DetectorHit[]): void {
    for (const hit of hits) {
      pushBoundedEntry(state.loops, {
        detector: hit.detector,
        detail: hit.detail,
        ts: hit.ts,
        count: hit.count,
      });
    }
  }

  private recordBreaches(state: SessionState, breaches: readonly BudgetBreach[]): void {
    for (const breach of breaches) pushBoundedEntry(state.breaches, breach);
  }

  private trigger(
    state: SessionState,
    reason: "loop" | "budget",
    hits: readonly DetectorHit[],
    breaches: readonly BudgetBreach[],
  ): Decision {
    state.triggered = true;
    state.stopped = !this.config.dry_run;
    const description = describeKill(reason, hits, breaches);
    state.reason = this.config.dry_run ? `would kill: ${description}` : description;
    return {
      action: "kill",
      reason,
      hits,
      breaches,
      dry_run: this.config.dry_run,
    };
  }

  private buildReport(state: SessionState): SessionReport {
    const budget = state.budgets.snapshot();
    return {
      schema_version: "1",
      session_id: state.id,
      stopped: state.stopped,
      dry_run: this.config.dry_run,
      reason: state.reason,
      started_at: new Date(state.startTs).toISOString(),
      updated_at: new Date(state.lastTs).toISOString(),
      duration_s: Math.round(budget.wall_seconds * 1000) / 1000,
      events: { tool: budget.tool_events, model: budget.model_events },
      tokens_est: { value: budget.tokens_est, source: "estimate", formula: "ceil(chars/4)" },
      loops: state.loops.map((item) => ({
        detector: item.detector,
        detail: item.detail,
        at: new Date(item.ts).toISOString(),
        count: item.count,
      })),
      budget_breaches: state.breaches.map((item) => ({
        budget: item.budget,
        limit: item.limit,
        observed: item.observed,
        at: new Date(item.ts).toISOString(),
      })),
      warnings: state.warnings.map((item) => ({
        detector: item.detector,
        detail: item.detail,
        at: new Date(item.ts).toISOString(),
      })),
      thresholds: {
        on_loop: this.config.on_loop,
        budgets: {
          max_tokens_est: this.config.budgets.max_tokens_est,
          max_wall_seconds: this.config.budgets.max_wall_seconds,
          max_consecutive_failures: this.config.budgets.max_consecutive_failures,
        },
      },
    };
  }
}

function pushBoundedEntry<T>(entries: T[], entry: T): void {
  entries.push(entry);
  if (entries.length > MAX_LOG_ENTRIES) entries.splice(0, entries.length - MAX_LOG_ENTRIES);
}
