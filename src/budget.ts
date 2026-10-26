import type { BudgetsConfig } from "./config.js";
import type { BudgetBreach, GuardEvent } from "./types.js";

export interface BudgetSnapshot {
  readonly tokens_est: number;
  readonly wall_seconds: number;
  readonly consecutive_failures: number;
  readonly tool_events: number;
  readonly model_events: number;
}

export class BudgetTracker {
  private tokens = 0;
  private consecutiveFailures = 0;
  private toolEvents = 0;
  private modelEvents = 0;
  private lastTs: number;

  constructor(
    private readonly budgets: BudgetsConfig,
    private readonly startTs: number,
  ) {
    this.lastTs = startTs;
  }

  observe(event: GuardEvent): BudgetBreach[] {
    this.lastTs = Math.max(this.lastTs, event.ts);
    const breaches: BudgetBreach[] = [];
    if (event.type === "tool.start" || event.type === "tool.end") this.toolEvents += 1;
    if (event.type === "model.context") {
      this.modelEvents += 1;
      this.tokens += Math.ceil(event.chars / 4);
      if (this.tokens > this.budgets.max_tokens_est) {
        breaches.push({
          budget: "max_tokens_est",
          limit: this.budgets.max_tokens_est,
          observed: this.tokens,
          ts: event.ts,
        });
      }
    }
    if (event.type === "tool.end") {
      this.consecutiveFailures = event.status === "error" ? this.consecutiveFailures + 1 : 0;
      if (this.consecutiveFailures > this.budgets.max_consecutive_failures) {
        breaches.push({
          budget: "max_consecutive_failures",
          limit: this.budgets.max_consecutive_failures,
          observed: this.consecutiveFailures,
          ts: event.ts,
        });
      }
    }
    const wallSeconds = this.wallSeconds();
    if (wallSeconds > this.budgets.max_wall_seconds) {
      breaches.push({
        budget: "max_wall_seconds",
        limit: this.budgets.max_wall_seconds,
        observed: wallSeconds,
        ts: event.ts,
      });
    }
    return breaches;
  }

  wallSeconds(): number {
    return Math.max(0, (this.lastTs - this.startTs) / 1000);
  }

  snapshot(): BudgetSnapshot {
    return {
      tokens_est: this.tokens,
      wall_seconds: this.wallSeconds(),
      consecutive_failures: this.consecutiveFailures,
      tool_events: this.toolEvents,
      model_events: this.modelEvents,
    };
  }
}
