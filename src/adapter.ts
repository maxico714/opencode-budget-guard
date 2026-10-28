import { ConfigError, resolveConfig, type GuardConfig } from "./config.js";
import { Guard } from "./guard.js";
import { writeReportsSync } from "./report.js";
import type { Decision, GuardEvent, SessionReport } from "./types.js";
import { stableStringify } from "./util.js";

export interface HostToolEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly input: unknown;
  readonly status?: "completed" | "error";
  readonly error?: { readonly message?: string };
}

export interface HostContextEvent {
  readonly sessionID: string;
  readonly messages?: unknown;
  readonly system?: unknown;
}

/**
 * The subset of the OpenCode v2 plugin context this adapter uses. Keeping the
 * surface small lets the adapter be tested without a live OpenCode session.
 */
export interface GuardHost {
  readonly options: Readonly<Record<string, unknown>>;
  readonly location: { readonly directory: string };
  readonly tool: {
    hook(
      name: "execute.before" | "execute.after",
      callback: (event: HostToolEvent) => Promise<void> | void,
    ): Promise<unknown>;
  };
  readonly session: {
    hook(name: "context", callback: (event: HostContextEvent) => Promise<void> | void): Promise<unknown>;
    interrupt(input: {
      readonly sessionID: string;
      readonly resume: boolean;
    }): Promise<{ readonly interrupted: boolean }>;
  };
}

export type LogLevel = "info" | "warn" | "error";

export interface AdapterDeps {
  readonly now?: () => number;
  readonly log?: (level: LogLevel, message: string) => void;
  readonly onReport?: (report: SessionReport, paths: readonly string[]) => void;
}

export interface AttachedGuard {
  readonly config: GuardConfig | null;
  readonly guard: Guard | null;
  readonly ready: Promise<void>;
  cleanup(): Promise<void>;
}

function defaultLog(level: LogLevel, message: string): void {
  const line = `[budget-guard] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

function payloadChars(event: HostContextEvent): number {
  const payload = [event.system ?? null, event.messages ?? null];
  try {
    const text = JSON.stringify(payload);
    return typeof text === "string" ? text.length : 0;
  } catch {
    // Circular/BigInt payloads must still contribute to the token estimate.
    return stableStringify(payload).length;
  }
}

export function attach(host: GuardHost, deps: AdapterDeps = {}): AttachedGuard {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;
  let config: GuardConfig;
  try {
    config = resolveConfig(host.options ?? {});
  } catch (error) {
    const message =
      error instanceof ConfigError && error.path !== ""
        ? `${error.message} (at ${error.path})`
        : error instanceof Error
          ? error.message
          : String(error);
    log("error", `invalid configuration, guard disabled: ${message}`);
    return { config: null, guard: null, ready: Promise.resolve(), cleanup: async () => {} };
  }
  const guard = new Guard(config);
  const baseDir = host.location.directory;

  const persist = (sessionID: string): void => {
    const report = guard.snapshot(sessionID);
    if (report === null) return;
    try {
      const paths = writeReportsSync(baseDir, config.report, report);
      if (paths.length > 0) log("info", `wrote report ${paths.join(", ")}`);
      if (deps.onReport !== undefined) deps.onReport(report, paths);
    } catch (error) {
      log("error", `failed to write report: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handle = async (event: GuardEvent): Promise<void> => {
    let decision: Decision;
    try {
      decision = guard.ingest(event);
    } catch (error) {
      log("error", `ignored invalid event: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (decision.action === "none") return;
    if (decision.action === "warn") {
      for (const hit of decision.hits) log("warn", `${hit.detector}: ${hit.detail}`);
      persist(event.sessionID);
      return;
    }
    const summary =
      decision.reason === "budget"
        ? decision.breaches.map((item) => `${item.budget}=${item.observed} (limit ${item.limit})`).join(", ")
        : decision.hits.map((item) => `${item.detector}: ${item.detail}`).join("; ");
    log("warn", decision.dry_run ? `would stop session: ${summary}` : `stopping session: ${summary}`);
    persist(event.sessionID);
    if (decision.dry_run) return;
    try {
      const result = await host.session.interrupt({ sessionID: event.sessionID, resume: false });
      if (!result.interrupted) log("warn", `session ${event.sessionID} was already idle`);
    } catch (error) {
      log("error", `failed to interrupt session: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const register = async (): Promise<void> => {
    await host.tool.hook("execute.before", (event) =>
      handle({
        type: "tool.start",
        sessionID: event.sessionID,
        tool: event.tool,
        input: event.input,
        ts: now(),
      }),
    );
    await host.tool.hook("execute.after", (event) =>
      handle({
        type: "tool.end",
        sessionID: event.sessionID,
        tool: event.tool,
        input: event.input,
        status: event.status ?? "completed",
        ...(event.error?.message === undefined ? {} : { error: event.error.message }),
        ts: now(),
      }),
    );
    await host.session.hook("context", (event) =>
      handle({
        type: "model.context",
        sessionID: event.sessionID,
        chars: payloadChars(event),
        ts: now(),
      }),
    );
  };

  const ready = register();

  return {
    config,
    guard,
    ready,
    async cleanup(): Promise<void> {
      await ready;
      for (const report of guard.snapshotAll()) persist(report.session_id);
    },
  };
}
