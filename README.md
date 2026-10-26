# opencode-budget-guard

Loop detection and a hard budget kill-switch for [OpenCode](https://opencode.ai) agent sessions.

Unattended agents get stuck. They repeat the same failing edit, oscillate between two states, or keep
calling one tool with identical arguments — burning wall-clock time and tokens while nobody watches.
This plugin watches a session, recognises those loops, enforces token/wall-time/failure budgets, and
stops the session with a written report that explains why.

Community plugin, not an OpenCode project. MIT licensed, zero runtime dependencies.

## What it does

- **Detects loops** with three independent detectors:
  - `tool_repeat` — the same tool with the same input hash N times inside a window (default 5 / 120s).
  - `identical_fail` — the same tool failing with the same normalised error N times (default 3 / 300s).
  - `oscillation` — a file edited A → B → A → B, i.e. write/revert churn (default 2 alternations / 60s).
- **Enforces budgets**: estimated tokens, wall-clock seconds, consecutive failures.
- **Stops cleanly**: on a loop (`on_loop: kill`) or any budget breach the plugin writes a report and
  interrupts the session. Budget breaches always stop the session; loops can warn first.
- **Reports**: JSON and Markdown with detections, breaches, event counts and the effective thresholds.
- **Replays recordings**: the CLI can run the same engine over a recorded JSONL event stream, so a
  stopped session can be explained offline.

## Install

OpenCode 2.x loads plugins from `plugins` in `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-budget-guard",
      "options": {
        "on_loop": "kill",
        "budgets": { "max_tokens_est": 200000, "max_wall_seconds": 3600 },
      },
    },
  ],
}
```

Until the package is published to npm, point at a local checkout instead — configure an **absolute**
path to a directory that re-exports the package, e.g. `<project>/plugins/budget-guard/index.js`:

```js
export { default } from "opencode-budget-guard";
```

and `"package": "C:/work/project/plugins/budget-guard"`. Bare names are installed from the registry by
OpenCode; relative paths are treated as package names too. See [docs/PLUGIN_API.md](docs/PLUGIN_API.md).

## Configuration

Options are validated strictly: unknown keys are an error, not silently ignored.

| Key                                | Default                               | Meaning                                            |
| ---------------------------------- | ------------------------------------- | -------------------------------------------------- |
| `detectors.tool_repeat`            | `{threshold: 5, window_seconds: 120}` | Same tool + identical input                        |
| `detectors.identical_fail`         | `{threshold: 3, window_seconds: 300}` | Same tool + same normalised error                  |
| `detectors.oscillation`            | `{count: 2, window_seconds: 60}`      | A→B→A alternations per tool + path                 |
| `budgets.max_tokens_est`           | `100000`                              | Estimated prompt tokens (`ceil(chars/4)`)          |
| `budgets.max_wall_seconds`         | `3600`                                | Session wall-clock, sampled on each event          |
| `budgets.max_consecutive_failures` | `5`                                   | Error events without a success in between          |
| `on_loop`                          | `"warn"`                              | `"warn"` or `"kill"`; budget breaches always kill  |
| `dry_run`                          | `false`                               | Log and report would-be kills without stopping     |
| `warn_repeat_seconds`              | `60`                                  | Minimum gap between identical warnings             |
| `report.json`                      | `".budget-guard/report.json"`         | Relative to the session directory; `null` disables |
| `report.markdown`                  | `".budget-guard/report.md"`           | Same                                               |

Each detector also accepts `enabled: false`. Thresholds of `0` are treated as `1` (fire on the first
sample); `window_seconds` must be at least `1`.

## CLI

```console
$ opencode-budget-guard doctor
opencode-budget-guard 0.1.0 doctor
config: defaults — valid
node: v24.18.0
detectors: identical_fail=on(3/300s) tool_repeat=on(5/120s) oscillation=on(2/60s)
budgets: max_tokens_est=100000 max_wall_seconds=3600 max_consecutive_failures=5
on_loop: warn
report: json=.budget-guard/report.json markdown=.budget-guard/report.md
OK
```

Replay a recorded stream:

```console
$ opencode-budget-guard replay --events fixtures/loops/tool-repeat.jsonl --config fixtures/config/tight.json
config: fixtures/config/tight.json
events: 6, sessions: 1
session demo-tool-repeat: STOPPED
  reason: loop: tool_repeat (tool 'bash' called with identical input 3 times within 120s)
  events: 3 tool, 0 model
  tokens_est: 0
  loops: 1, breaches: 0, warnings: 0
guard triggered
```

Exit codes: `0` finished without a trigger, `1` configuration error, `2` usage/input error,
`3` the guard triggered (also under `--dry-run`).

Event streams are JSONL:

```json
{"type":"tool.start","sessionID":"s1","tool":"edit","input":{"filePath":"src/a.ts"},"ts":1700000000000}
{"type":"tool.end","sessionID":"s1","tool":"edit","input":{"filePath":"src/a.ts"},"status":"error","error":"ENOENT: missing","ts":1700000001000}
{"type":"model.context","sessionID":"s1","chars":4000,"ts":1700000002000}
```

## Fixtures

| Stream                                | Config                        | Expected                         |
| ------------------------------------- | ----------------------------- | -------------------------------- |
| `fixtures/no-loop/clean.jsonl`        | defaults                      | no trigger, exit 0               |
| `fixtures/loops/tool-repeat.jsonl`    | `fixtures/config/tight.json`  | `tool_repeat`, stopped           |
| `fixtures/loops/identical-fail.jsonl` | `fixtures/config/tight.json`  | `identical_fail`, stopped        |
| `fixtures/loops/oscillation.jsonl`    | `fixtures/config/tight.json`  | `oscillation`, stopped           |
| `fixtures/budgets/token-budget.jsonl` | `fixtures/config/budget.json` | `max_tokens_est` breach, stopped |

## Honest limitations

- **Tokens are estimates.** Neither tool results nor the context hook expose provider billing, so the
  guard counts characters of the assembled prompt and divides by four. The report labels the value
  `"source": "estimate"` and prints the formula. Do not use it for invoicing.
- **Wall time is event-driven.** There is no timer: the budget is checked when the next event arrives.
  An idle session with no events cannot spend tokens either, so this is a trade-off, not a gap in the
  loop detectors.
- **Oscillation works on input hashes, not file contents.** A → B → A is detected for the same tool and
  the same path field; unrelated edits that happen to alternate cannot be distinguished from churn.
- **The session stops, not the process.** The plugin calls OpenCode's `session.interrupt`; the CLI then
  exits non-zero. Anything outside the session (background shells you started) is untouched.
- **Config is JSON.** The scaffold sketched YAML; the implementation accepts JSON only (plugin options
  arrive as a JS object, and the CLI reads JSON files). Fewer dependencies, same semantics.
- **Absorption risk.** OpenCode issue #27167 tracks a native budget/loop feature. If it ships, this
  plugin may be superseded; its detector heuristics and report format are the parts most worth keeping.
- **V2 only.** Verified against `@opencode/cli` 2.1.2 on Windows. Not tested on 1.x, macOS or Linux.

## Development

```console
$ npm ci
$ npm run check        # build, typecheck, oxlint, prettier --check, 142 tests
$ npm run test         # node:test suite (compiled to build-test/)
$ node scripts/e2e-mock-provider.mjs   # real OpenCode session against a local mock model server
```

The e2e script packs the repo, installs the tarball into a temp project, starts an OpenAI-compatible
mock server that always requests the same `shell` call, runs `opencode run --standalone`, and asserts
that the guard stopped the session and wrote a report. It needs an `opencode` binary on `PATH` (or
`OPENCODE_BIN`) and makes no external network calls.

Architecture, threat model and verification levels: [docs/TECHNICAL.md](docs/TECHNICAL.md).
Plugin API evidence: [docs/PLUGIN_API.md](docs/PLUGIN_API.md).

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
