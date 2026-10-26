# EVIDENCE — opencode-budget-guard

Research judgement (2026-10-10, round-2 M2 verifier + ADR-002 fallback list, ledger row 22) followed by
build-time verification on **2026-10-26**. Claims are split by date so older research is not presented as
fresh evidence.

## Gap class and demand (research, 2026-10-10)

- Class **A** for loop detection: no mature open-source OpenCode plugin combining loop detectors with a
  budget kill-switch was found in the round-2 search.
- **OpenCode #27167** tracks a native budget/loop feature. Absorption risk is real, accepted (D-005), and
  stated in the README.
- Demand hook strength 3/5 (capped per D-006): real issue tracker signal, growing but not saturated.

## Gate 0 competitor re-check (2026-10-26)

Queries run: npm registry lookup for `opencode-budget-guard` and GitHub repository/code search for
OpenCode plugins combining loop detection with budgets (`opencode loop guard`, `opencode budget plugin`,
`opencode kill switch`, `opencode workflow guard`, `opencode auto resume`, `four-bytes guard`).

| Candidate                     | Status                                             | Scope                                          | Verdict                                                             |
| ----------------------------- | -------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------- |
| `opencode-budget-guard` (npm) | HTTP 404                                           | —                                              | name available                                                      |
| `opencode-workflow-guard`     | exists                                             | policy/permission enforcement around workflows | adjacent, no loop heuristics or budget kill-switch                  |
| `opencode-auto-resume`        | exists                                             | resumes stalled sessions                       | opposite goal (keeps a stuck agent alive)                           |
| `four-bytes guard`            | not found on npm or GitHub after the queries above | —                                              | cannot confirm the scaffold's incumbent; do not cite it as existing |

Negative-evidence rule: "no plugin combining these detectors with a session kill-switch was found in these
queries on 2026-10-26" — not "does not exist".

## Plugin API (Gate 0, 2026-10-26)

Verified from installed `@opencode/plugin@2.1.2` type definitions and upstream sources; written up in
`docs/PLUGIN_API.md`. The scaffold's assumed hook names (`onToolCall`, `onEdit`, `onError`) do **not**
exist. The real surface is `ctx.tool.hook("execute.before" | "execute.after")`,
`ctx.session.hook("context")` and `ctx.session.interrupt({ sessionID, resume: false })`.

Two of these surfaced only by running the real binary, not by reading types:

- `plugins` (plural) is the config key, and OpenCode **installs bare package names from the registry** even
  when the package is already in `node_modules` (`NpmInstallFailedError: 404`).
- Configured local plugins must be **directories** ("configured plugin path must be a directory") resolved
  by a root `server` or `index` entry, not by the package `exports` map.

## Verification evidence (2026-10-26)

| Check          | Command                                              | Result                                                                                                                               |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Static + tests | `npm run check`                                      | build, typecheck, oxlint (0 warnings), prettier, **142 tests pass**, smoke checks pass                                               |
| Mutation 1     | `samples.length >= threshold` → `>` in `tool_repeat` | `detectors.test.js`: 2 failures                                                                                                      |
| Mutation 2     | `tokens > limit` → `tokens >= limit`                 | `budget.test.js`: 1 failure                                                                                                          |
| Mutation 3     | warning dedupe removed in `Guard.shouldWarn`         | `guard.test.js`: 1 failure                                                                                                           |
| Fixtures       | `replay` on all five fixtures                        | clean exits 0; tool-repeat, identical-fail, oscillation and budget exit 3 with the expected reason                                   |
| CLI smoke      | `node scripts/smoke.mjs`                             | doctor 0, clean 0, loop 3                                                                                                            |
| L3 end-to-end  | `node scripts/e2e-mock-provider.mjs`                 | real OpenCode 2.1.2 session, mock OpenAI-compatible server, `PASS: real OpenCode session stopped by the guard with a written report` |
| Packaging      | `npm pack`, `npm publish --dry-run`                  | tarball 35.4 kB, 63 files, `prepublishOnly` check passes                                                                             |
| Secrets        | `detect-secrets scan` over the tree                  | 0 findings (recorded in the commit note)                                                                                             |
| L4             | fresh copy → `npm ci` → `npm run check`              | green (see PROGRESS note)                                                                                                            |
| CI             | GitHub Actions run `40303244380`                     | 6/6 jobs green: Ubuntu + Windows × Node 20/22/24                                                                                     |

L3 report captured during the run:

```json
{
  "schema_version": "1",
  "session_id": "ses_e888ea14…",
  "stopped": true,
  "reason": "loop: tool_repeat (tool 'shell' called with identical input 2 times within 120s)",
  "events": { "tool": 3, "model": 2 },
  "tokens_est": { "value": 4479, "source": "estimate", "formula": "ceil(chars/4)" },
  "loops": [{ "detector": "tool_repeat", "count": 2 }]
}
```

## Failure modes encountered while building

| Symptom                                        | Cause                                                                             | Fix                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| `node --test <dir>` failed to resolve          | directory arguments are not supported this way on Node 24                         | pass a glob (`build-test/test/*.test.js`)        |
| Test suite hung forever                        | `snapshotAll` iterated live LRU keys while `get()` reordered the map              | iterate an `entries()` snapshot                  |
| Loop-cap test reported 5 entries instead of 50 | the default `max_consecutive_failures` killed the session first                   | raise that budget inside the test                |
| Report missing after a real kill               | async write raced the session abort                                               | write reports synchronously before `interrupt()` |
| e2e found no report                            | `PWD` from bash pointed the CLI at the repo, so reports went to the wrong project | set `PWD` to the temp project in the harness     |
| e2e plugin never loaded                        | bare name → registry install; file path → "must be a directory"                   | use a local directory with an `index.js` entry   |

## Not verified

- macOS and Linux hosts; OpenCode 1.x; Effect-style plugins.
- Registry publication (G3 gate not approved) and the resulting install path from npm.
- Long-duration memory behaviour beyond the 50k-event unit scenario and one real session.

## Score

67/105 (round-2 runner-up, ADR-002 fallback). Surviving conditions from the skeptic pass — loop-led
scope, competitor re-check, mock-only verification, assume native absorption — are all met: the detectors
lead the README, the competitor check is dated above, tests use a fake host plus a local mock model
server, and the README states the absorption risk.
