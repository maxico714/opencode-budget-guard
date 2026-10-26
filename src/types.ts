export type GuardEvent =
  | {
      readonly type: "tool.start";
      readonly sessionID: string;
      readonly tool: string;
      readonly input: unknown;
      readonly ts: number;
    }
  | {
      readonly type: "tool.end";
      readonly sessionID: string;
      readonly tool: string;
      readonly input: unknown;
      readonly status: "completed" | "error";
      readonly error?: string;
      readonly ts: number;
    }
  | {
      readonly type: "model.context";
      readonly sessionID: string;
      readonly chars: number;
      readonly ts: number;
    };

export type DetectorName = "identical_fail" | "tool_repeat" | "oscillation";

export type BudgetName = "max_tokens_est" | "max_wall_seconds" | "max_consecutive_failures";

export interface DetectorHit {
  readonly detector: DetectorName;
  readonly key: string;
  readonly detail: string;
  readonly count: number;
  readonly threshold: number;
  readonly ts: number;
}

export interface BudgetBreach {
  readonly budget: BudgetName;
  readonly limit: number;
  readonly observed: number;
  readonly ts: number;
}

export type Decision =
  | { readonly action: "none" }
  | { readonly action: "warn"; readonly hits: readonly DetectorHit[] }
  | {
      readonly action: "kill";
      readonly reason: "loop" | "budget";
      readonly hits: readonly DetectorHit[];
      readonly breaches: readonly BudgetBreach[];
      readonly dry_run: boolean;
    };

export interface SessionReport {
  readonly schema_version: "1";
  readonly session_id: string;
  readonly stopped: boolean;
  readonly dry_run: boolean;
  readonly reason: string | null;
  readonly started_at: string;
  readonly updated_at: string;
  readonly duration_s: number;
  readonly events: { readonly tool: number; readonly model: number };
  readonly tokens_est: {
    readonly value: number;
    readonly source: "estimate";
    readonly formula: "ceil(chars/4)";
  };
  readonly loops: readonly {
    readonly detector: DetectorName;
    readonly detail: string;
    readonly at: string;
    readonly count: number;
  }[];
  readonly budget_breaches: readonly {
    readonly budget: BudgetName;
    readonly limit: number;
    readonly observed: number;
    readonly at: string;
  }[];
  readonly warnings: readonly {
    readonly detector: DetectorName;
    readonly detail: string;
    readonly at: string;
  }[];
  readonly thresholds: {
    readonly on_loop: "warn" | "kill";
    readonly budgets: {
      readonly max_tokens_est: number;
      readonly max_wall_seconds: number;
      readonly max_consecutive_failures: number;
    };
  };
}
