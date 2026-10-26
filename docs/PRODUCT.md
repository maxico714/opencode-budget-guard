# PRODUCT — opencode-budget-guard

Status: v0.1.0 built, tested and verified (2026-10-26). Community plugin, MIT.

## Problem

AI coding agents can enter failure loops — repeated identical tool calls, edit oscillation
(write → revert → write), or stuck reasoning — and burn tokens, wall-clock time and API quota before a
human notices. Teams running agents unattended (CI, overnight runs) need a circuit breaker that stops the
agent **before** cost spirals, with a report explaining why it stopped.

## Target users (personas)

1. **Solo developer running agents unattended (primary):** overnight OpenCode sessions on side projects or
   refactors. Job: wake up to a finished task, not a surprise bill.
2. **Team lead running agents in CI (secondary):** agent-assisted PRs and batch jobs. Job: a hard budget
   cap per job and loop detection that does not leave pipelines stuck.
3. **Cost-conscious power user (tertiary):** heavy tool/MCP sessions. Job: stop runaway tool loops and see
   what happened afterwards.

## Jobs-to-be-done

- "Stop the agent if it repeats the same failed action three times."
- "Hard-cap estimated tokens and wall time per session, and stop cleanly when the cap is hit."
- "Show me a post-session report: what looped, what was spent, why it stopped."

## Value proposition

An OpenCode plugin that detects agent loops and enforces token/wall-time/failure budgets with a clean
kill-switch and a written report — for people who run agents when nobody is watching.

## Non-goals

- Not a multi-provider billing dashboard; token numbers are labelled estimates.
- Not a prompt optimiser or model router.
- Not a replacement for a native OpenCode budget feature; if one lands, this plugin may be superseded.
- Not a wrapper around a provider: tests use a fake host and a local mock model server only.

## MVP scope (v0.1, delivered)

**Must — delivered:**

- OpenCode 2 plugin using the verified hook surface (`execute.before`, `execute.after`, `session context`).
- Detectors: identical failures, tool-call repeat, edit oscillation — each windowed and configurable.
- Budgets: estimated tokens, wall time, consecutive failures.
- Kill-switch: warn or kill on loops, always kill on budget breach, `dry_run`, clean `session.interrupt`,
  JSON + Markdown report.
- Mock provider integration for tests: fake host (L2) and a real session against a local mock server (L3).
- JSON config, `doctor` self-check, `replay` for recorded streams.
- Adversarial coverage and bounded memory.

**Deferred:** per-tool token attribution, CI-artefact report variants, metrics endpoint, registry publish.

## Success criteria

| Criterion      | Measure                                                                                        | Proof                                        |
| -------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------- |
| L1 units       | Detector, budget, guard, window units green                                                    | `npm test` — 142 tests pass                  |
| L2 integration | Fake-host session: loop kills, budget kills, report written, no-loop does not kill             | `test/adapter.test.ts`, `test/guard.test.ts` |
| L3 end-to-end  | Real OpenCode session with a mock provider stops on a loop and writes a report                 | `node scripts/e2e-mock-provider.mjs` → PASS  |
| L4 clean env   | Fresh copy + `npm ci` + `npm run check` green                                                  | recorded in `BUILD_CHECKLIST.md`             |
| L5 adversarial | Zero threshold, 1 MiB line, invalid UTF-8, DAG/deep/circular input, 20k/50k events             | `test/adversarial.test.ts`                   |
| Honesty        | README states absorption risk, estimate caveat and event-driven wall clock; no "native" claims | manual review                                |
| Mock-only      | No live API keys; CI has no network-dependent tests                                            | CI config + secrets scan (0 findings)        |

## Honest comparison

- **OpenCode native (#27167):** may land. If it does, its value is a built-in budget; this plugin's
  detector heuristics, escalation ladder and report format are the parts worth keeping.
- **`opencode-workflow-guard`:** policy/permission enforcement around workflows; no loop heuristics or
  budget kill-switch.
- **`opencode-auto-resume`:** keeps stalled sessions alive — the opposite goal.
- **Generic timeout scripts:** wall time only, no loop detection, no report, no clean interrupt.
- **Cloud cost dashboards:** post-hoc billing; this is a pre-spend circuit breaker.

## Naming and licence

- `opencode-budget-guard` — descriptive, and the npm name was free on 2026-10-26. Community plugin; it is
  not an OpenCode project and uses no OpenCode marks beyond the descriptive prefix.
- MIT.

## Risk register

| Risk                                      | Severity | Mitigation                                                                                   |
| ----------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| #27167 lands natively and supersedes this | High     | accepted; complement posture; honest README                                                  |
| False-positive kills                      | Medium   | `on_loop: warn` default, configurable thresholds, `dry_run`, clean-stream fixture and test   |
| Plugin API churn                          | Medium   | one adapter file, pinned `@opencode/plugin`, structural export with compile-time conformance |
| Token estimates mislead users             | Medium   | labelled in reports, README and Markdown footer; formula printed                             |
| Reports leak sensitive paths              | Low      | documented contents; no prompts, message bodies or tool output                               |
