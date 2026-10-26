import { mkdir, rename, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ReportConfig } from "./config.js";
import { ConfigError } from "./config.js";
import type { SessionReport } from "./types.js";

export function reportToJson(report: SessionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function reportToMarkdown(report: SessionReport): string {
  const lines: string[] = [];
  lines.push(`# Budget guard report — ${report.session_id}`, "");
  lines.push(`- Stopped: **${report.stopped ? "yes" : "no"}**${report.dry_run ? " (dry run)" : ""}`);
  lines.push(`- Reason: ${report.reason ?? "none"}`);
  lines.push(`- Started: ${report.started_at}`);
  lines.push(`- Updated: ${report.updated_at}`);
  lines.push(`- Duration: ${report.duration_s.toFixed(3)}s`);
  lines.push(`- Tool events: ${report.events.tool}`);
  lines.push(`- Model calls: ${report.events.model}`);
  lines.push(`- Tokens (estimate, ceil(chars/4)): ${report.tokens_est.value}`);
  lines.push("");
  lines.push("## Loop detections", "");
  if (report.loops.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Detector | Count | At | Detail |", "|---|---|---|---|");
    for (const loop of report.loops) {
      lines.push(`| ${loop.detector} | ${loop.count} | ${loop.at} | ${escapeCell(loop.detail)} |`);
    }
  }
  lines.push("", "## Budget breaches", "");
  if (report.budget_breaches.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Budget | Limit | Observed | At |", "|---|---|---|---|");
    for (const breach of report.budget_breaches) {
      lines.push(`| ${breach.budget} | ${breach.limit} | ${breach.observed} | ${breach.at} |`);
    }
  }
  lines.push("", "## Warnings", "");
  if (report.warnings.length === 0) {
    lines.push("None.");
  } else {
    for (const warning of report.warnings) lines.push(`- ${warning.at} — ${warning.detector}: ${warning.detail}`);
  }
  lines.push("", "## Thresholds", "");
  lines.push(`- on_loop: ${report.thresholds.on_loop}`);
  lines.push(`- max_tokens_est: ${report.thresholds.budgets.max_tokens_est}`);
  lines.push(`- max_wall_seconds: ${report.thresholds.budgets.max_wall_seconds}`);
  lines.push(`- max_consecutive_failures: ${report.thresholds.budgets.max_consecutive_failures}`);
  lines.push("", "Token values are estimates derived from prompt character counts, not provider billing data.", "");
  return lines.join("\n");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function formatSummary(report: SessionReport): string {
  const state = report.stopped ? "STOPPED" : report.dry_run ? "DRY RUN" : "running";
  const lines = [
    `session ${report.session_id}: ${state}`,
    `  reason: ${report.reason ?? "none"}`,
    `  events: ${report.events.tool} tool, ${report.events.model} model`,
    `  tokens_est: ${report.tokens_est.value}`,
    `  loops: ${report.loops.length}, breaches: ${report.budget_breaches.length}, warnings: ${report.warnings.length}`,
  ];
  return `${lines.join("\n")}\n`;
}

export function resolveReportPath(baseDir: string, target: string): string {
  if (isAbsolute(target)) {
    throw new ConfigError(`report path must be relative, got '${target}'`, "report");
  }
  const base = resolve(baseDir);
  const resolved = resolve(base, target);
  const rel = relative(base, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new ConfigError(`report path escapes the base directory: '${target}'`, "report");
  }
  return resolved;
}

export async function writeReports(baseDir: string, config: ReportConfig, report: SessionReport): Promise<string[]> {
  const written: string[] = [];
  const targets: [string | null, string][] = [
    [config.json, reportToJson(report)],
    [config.markdown, reportToMarkdown(report)],
  ];
  for (const [target, content] of targets) {
    if (target === null) continue;
    const path = resolveReportPath(baseDir, target);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
    written.push(path);
  }
  return written;
}

/**
 * Synchronous variant for plugin hooks that must finish before the host aborts the
 * session; an async write scheduled after an interrupt can be lost with the process.
 */
export function writeReportsSync(baseDir: string, config: ReportConfig, report: SessionReport): string[] {
  const written: string[] = [];
  const targets: [string | null, string][] = [
    [config.json, reportToJson(report)],
    [config.markdown, reportToMarkdown(report)],
  ];
  for (const [target, content] of targets) {
    if (target === null) continue;
    const path = resolveReportPath(baseDir, target);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
    written.push(path);
  }
  return written;
}
