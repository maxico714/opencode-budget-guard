import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GuardHost, HostContextEvent, HostToolEvent, LogLevel } from "../src/adapter.js";
import { resolveConfig, type GuardConfig } from "../src/config.js";
import type { GuardEvent } from "../src/types.js";

export const T0 = 1_700_000_000_000;

export function config(overrides: Record<string, unknown> = {}): GuardConfig {
  return resolveConfig(overrides);
}

export function toolStart(
  sessionID: string,
  tool: string,
  input: unknown,
  ts: number,
): Extract<GuardEvent, { type: "tool.start" }> {
  return { type: "tool.start", sessionID, tool, input, ts };
}

export function toolEnd(
  sessionID: string,
  tool: string,
  input: unknown,
  ts: number,
  status: "completed" | "error" = "completed",
  error?: string,
): Extract<GuardEvent, { type: "tool.end" }> {
  return error === undefined
    ? { type: "tool.end", sessionID, tool, input, status, ts }
    : { type: "tool.end", sessionID, tool, input, status, error, ts };
}

export function modelContext(
  sessionID: string,
  chars: number,
  ts: number,
): Extract<GuardEvent, { type: "model.context" }> {
  return { type: "model.context", sessionID, chars, ts };
}

export async function tempDir(prefix = "budget-guard-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

type HookCallback = (event: HostToolEvent | HostContextEvent) => Promise<void> | void;

export class FakeHost implements GuardHost {
  readonly options: Record<string, unknown>;
  readonly location: { directory: string };
  readonly interrupts: string[] = [];
  readonly logs: { level: LogLevel; message: string }[] = [];
  interruptResult = true;
  interruptError: Error | null = null;
  private hooks = new Map<string, HookCallback>();

  constructor(directory: string, options: Record<string, unknown> = {}) {
    this.location = { directory };
    this.options = options;
  }

  readonly tool = {
    hook: async (
      name: "execute.before" | "execute.after",
      callback: (event: HostToolEvent) => Promise<void> | void,
    ): Promise<unknown> => {
      this.hooks.set(name, callback as HookCallback);
      return { dispose: async () => {} };
    },
  };

  readonly session = {
    hook: async (name: "context", callback: (event: HostContextEvent) => Promise<void> | void): Promise<unknown> => {
      this.hooks.set(name, callback as HookCallback);
      return { dispose: async () => {} };
    },
    interrupt: async (input: { sessionID: string; resume: boolean }): Promise<{ interrupted: boolean }> => {
      if (this.interruptError !== null) throw this.interruptError;
      this.interrupts.push(input.sessionID);
      return { interrupted: this.interruptResult };
    },
  };

  get hookNames(): string[] {
    return [...this.hooks.keys()].sort();
  }

  async fire(name: string, event: HostToolEvent | HostContextEvent): Promise<void> {
    const hook = this.hooks.get(name);
    if (hook === undefined) throw new Error(`hook '${name}' is not registered`);
    await hook(event);
  }
}
