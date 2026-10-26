# TECHNICAL — opencode-budget-guard

Status: v0.1.0 built, tested and verified on Windows 10 (26200) with Node 24.18.0 and OpenCode 2.1.2.
Date: 2026-10-26. Stack: TypeScript 5.9 (ESM, `NodeNext`), zero runtime dependencies.

## Architecture

```
OpenCode session
  │  execute.before / execute.after / session "context" hooks
  ▼
src/adapter.ts        normalises host events into GuardEvent, owns config + report paths
  ▼
src/guard.ts          per-session state (≤64 sessions), decisions, warning dedupe
  ├── src/detectors.ts  tool_repeat / identical_fail / oscillation (bounded sliding windows)
  ├── src/budget.ts     tokens_est, wall_seconds, consecutive_failures
  └── src/report.ts     JSON + Markdown, atomic write (tmp + rename)
  ▼
Decision: none | warn | kill
  ├── warn  → log, write report
  └── kill  → write report synchronously, then ctx.session.interrupt({resume:false})
```

`src/cli.ts` (`doctor`, `replay`) drives the same engine without the host, which is why the CLI and the
plugin cannot drift apart. `src/plugin.ts` exports `{ id, setup }` structurally, so the package imports
nothing at runtime while still being type-checked against `@opencode/plugin`.

```
src/
  types.ts      GuardEvent, Decision, SessionReport (schema_version "1")
  config.ts     strict JSON config reader, ConfigError (E_CONFIG), defaults
  util.ts       stableStringify (sorted keys, depth/node caps), hashInput, normalizeError, extractPath
  window.ts     BoundedMap (LRU, 4096 keys), pushBounded (256 samples, window prune)
  detectors.ts  the three detectors
  budget.ts     budget counters
  guard.ts      event validation, session state, decisions, reports
  report.ts     JSON/Markdown writers (sync + async), path containment
  adapter.ts    host glue, config failure => guard disabled with a logged error
  plugin.ts     OpenCode 2 plugin definition
  engine.ts     host-free public surface
  cli.ts        doctor / replay
```

## Detectors

| Detector         | Signal                                         | Default  | Fires when                                 |
| ---------------- | ---------------------------------------------- | -------- | ------------------------------------------ |
| `tool_repeat`    | tool + `sha256(stableStringify(input))`        | 5 / 120s | sample count ≥ threshold inside the window |
| `identical_fail` | tool + normalised first error line             | 3 / 300s | error count ≥ threshold inside the window  |
| `oscillation`    | tool + `filePath`-style path, input hash A→B→A | 2 / 60s  | alternations ≥ count inside the window     |

- `stableStringify` sorts keys, renders non-finite numbers as `null`, maps bigint to strings, marks
  cycles as `<circular>`, stops at depth 64 and 100k nodes (guards against shared-reference bombs).
- `normalizeError` keeps the first line, replaces Windows/POSIX paths with `<path>`, trims to 200 chars,
  so "same error" survives temp paths and stack noise.
- `extractPath` looks at `filePath`, `filepath`, `file_path`, `path`, `file` (≤4096 chars).
- Threshold `0` is clamped to `1`; windows must be ≥1s. Disabled detectors are not evaluated at all.

## Budgets

| Budget                     | Counting                                              | Breach             |
| -------------------------- | ----------------------------------------------------- | ------------------ |
| `max_tokens_est`           | `ceil(chars/4)` per `context` hook, summed over calls | `observed > limit` |
| `max_wall_seconds`         | last event timestamp − first event timestamp          | `observed > limit` |
| `max_consecutive_failures` | error `tool.end` events since the last completed one  | `observed > limit` |

Budget breaches always kill, ignoring `on_loop`. Wall time is evaluated when an event arrives: there is
no timer, and a session with no events is not spending tokens either.

## Decisions and persistence

- `Guard.ingest()` returns `none`, `warn` (deduplicated per detector+key within `warn_repeat_seconds`)
  or `kill` (reason `loop` or `budget`, with hits/breaches).
- After a kill the session is sticky: later events are ignored, so a slow host cannot re-trigger.
- The report is written **synchronously** before `interrupt()`: an asynchronous write scheduled after
  the abort can be lost when the process exits. Measured cost is a few milliseconds for a few KB.
- Cleanup unloads every tracked session and writes its final report.
- `dry_run` produces the same logs and reports but never interrupts; reports carry `dry_run: true`.
- Report paths must be relative and stay inside the session directory (`resolve` + `relative` check);
  writes are `tmp` + `rename` so a reader never sees half a file.

```json
{
  "schema_version": "1",
  "session_id": "ses_…",
  "stopped": true,
  "dry_run": false,
  "reason": "loop: tool_repeat (tool 'shell' called with identical input 2 times within 120s)",
  "started_at": "2026-10-26T09:02:41.000Z",
  "updated_at": "2026-10-26T09:02:45.978Z",
  "duration_s": 4.978,
  "events": { "tool": 3, "model": 2 },
  "tokens_est": { "value": 4479, "source": "estimate", "formula": "ceil(chars/4)" },
  "loops": [{ "detector": "tool_repeat", "detail": "…", "at": "…", "count": 2 }],
  "budget_breaches": [],
  "warnings": [],
  "thresholds": { "on_loop": "kill", "budgets": { "max_tokens_est": 1000000000, "…": "…" } }
}
```

## Interfaces

- Plugin entry (default export): `{ id: "budget-guard", setup(ctx) }` — verified against OpenCode 2.1.2,
  see `docs/PLUGIN_API.md`.
- Engine (`opencode-budget-guard/engine`): `Guard`, `resolveConfig`, `Detectors`, `BudgetTracker`,
  `attach`, report helpers, `hashInput`/`normalizeError`/`stableStringify`.
- CLI: `doctor [--config f] [--json]`, `replay --events f [--config f] [--json] [--markdown f] [--dry-run]`.
  Exit codes: `0` ok, `1` config error, `2` usage/input error, `3` triggered.

## Limits and failure modes

| Limit                             | Value                | Behaviour on breach                                                  |
| --------------------------------- | -------------------- | -------------------------------------------------------------------- |
| Tracked sessions                  | 64 (LRU)             | oldest session report dropped, no crash                              |
| Samples per key                   | 256                  | oldest samples pruned                                                |
| Detector keys per session         | 4096 each (LRU)      | oldest key dropped                                                   |
| Logged loops/warnings per session | 50                   | oldest entries dropped                                               |
| Event `sessionID` / `tool`        | 256 / 200 chars      | event rejected (logged, session continues)                           |
| Event `ts`                        | integer ≤ 8.64e15 ms | event rejected                                                       |
| Input depth / nodes               | 64 / 100k            | marked `<max-depth>` / `<truncated>`                                 |
| Replay line size                  | 1 MiB                | exit 2 with the line number                                          |
| Invalid config                    | —                    | plugin logs `invalid configuration, guard disabled` and does nothing |

## Threat model (STRIDE-lite)

- **Untrusted input:** every event is validated (`EventError`), hashes are depth/node bounded, error
  signatures are normalised and truncated. A hostile 1 MiB line is rejected before parsing; invalid
  UTF-8 surfaces as a JSON error with a line number.
- **Report leakage:** reports contain session IDs, tool names, normalised error signatures and the path
  strings the model used. They do not contain prompts, message bodies or tool outputs. Write them
  somewhere you would be comfortable keeping build logs.
- **Path traversal:** report paths must be relative and inside the session directory; absolute paths and
  `..` escapes are rejected at config load and again at write time.
- **False-positive kills:** `on_loop: warn` is the default, thresholds are configurable, `dry_run`
  reports without stopping, and `fixtures/no-loop/clean.jsonl` plus the 20k-event replay guard the
  no-loop regression.
- **Supply chain:** no runtime dependencies; `@opencode/plugin` is a pinned devDependency used only for
  types; npm lockfile committed; CI actions pinned to commit SHAs.
- **No telemetry, no network:** the plugin and CLI never make network calls.

## Performance

- Detector work per event is O(window samples) with caps (≤256 per key, ≤8 oscillation entries), measured
  at well under a millisecond in unit tests.
- 20,000-event replay completes in ~0.3s in the test suite; 50,000 repeated tool calls keep the report at
  50 loop entries.
- Steady-state memory is bounded by the caps above; the L3 session used a few MB.

## Verification levels reached

| Level | Evidence                                                                                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0    | `npm run check` — build, typecheck, oxlint, prettier                                                                                                                               |
| L1    | 142 `node:test` cases across 9 files (`test/*.test.ts`)                                                                                                                            |
| L2    | Adapter tests with a fake host: hooks, kill, dry-run, report-on-kill, failed interrupt                                                                                             |
| L3    | `scripts/e2e-mock-provider.mjs`: real OpenCode 2.1.2 session, mock OpenAI-compatible server, session stopped, report written                                                       |
| L4    | Fresh copy + `npm ci` + `npm run check` + README quickstart (recorded in `docs/EVIDENCE.md`)                                                                                       |
| L5    | Adversarial suite: DAG bomb, 5k-depth chain, circular input, 4 MiB strings, lone surrogates, 1 MiB line, invalid UTF-8, directory as input, zero thresholds, 20k/50k event volumes |

## Deliberate deviations from the scaffold

| Scaffold                               | Built                                              | Why                                                                   |
| -------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- |
| YAML config                            | JSON config                                        | plugin options arrive as JS objects; the CLI needs no YAML dependency |
| Hook names `onToolCall`/`onError`      | `execute.before`/`execute.after`/`session context` | the real API (verified)                                               |
| `edit`-event based oscillation         | path + input-hash alternation on `execute.before`  | no separate edit event exists in the hook surface                     |
| Token usage object                     | `ceil(chars/4)` estimate                           | no billed usage is exposed to plugins                                 |
| `--doctor`/`--dry-run` on plugin entry | `doctor`/`replay` CLI + `dry_run` option           | plugin entries are not argv-driven                                    |
