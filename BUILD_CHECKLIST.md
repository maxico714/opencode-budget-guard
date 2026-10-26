# BUILD CHECKLIST — opencode-budget-guard

Status: v0.1.0 built and verified 2026-10-26 (Windows 10 26200, Node 24.18.0, OpenCode 2.1.2).
Each gate lists the command that produced the evidence. Gate 8 (registry publish) stays open: the G3
gate is not approved.

## Gate 0 — API & competitor spike

- [x] Read the OpenCode plugin API from installed types and upstream sources; frozen in
      [docs/PLUGIN_API.md](docs/PLUGIN_API.md).
      Evidence: `node_modules/@opencode/plugin/dist/promise/{plugin,tool,session}.d.ts` (2.1.2),
      `packages/core/src/plugin/{supervisor,module}.ts`, `services/www/.../build/plugins/index.mdx`.
- [x] Real-session event verification. Evidence: `node scripts/e2e-mock-provider.mjs` — a real OpenCode
      session loaded the plugin, executed `shell` tool calls through the mock provider and the guard
      stopped it. Three loader rules were discovered by running it (plural `plugins` key; bare names are
      installed from the registry; local plugins must be directories with a root `index`/`server` entry).
- [x] Competitor check. Evidence: npm 404 for `opencode-budget-guard`; `opencode-workflow-guard` is
      adjacent policy enforcement; `opencode-auto-resume` resumes stalled sessions; `four-bytes guard`
      was not found in the queries run — see [docs/EVIDENCE.md](docs/EVIDENCE.md). No pivot needed.

## Gate 1 — L0 static

- [x] `npm run build` — tsc, ESM/NodeNext, strict, declarations emitted.
- [x] `npm run typecheck` — tests compiled with `--noEmit`.
- [x] `npm run lint` — oxlint, `--deny-warnings`, 24 files, 0 warnings.
- [x] `npm run format:check` — prettier over src, test, scripts, examples, docs, root markdown and JS.

## Gate 2 — L1 units

- [x] Detectors: `test/detectors.test.ts` (14 cases) — thresholds, windows, key isolation, disabled
      detectors, threshold 0.
- [x] Budgets: `test/budget.test.ts` — token estimate, wall clock, consecutive failures, zero limits.
- [x] Escalation: `test/guard.test.ts` (36 cases) — warn vs kill, dry-run, dedupe, sticky stop, session
      cap, 50-entry cap, report contents.
- [x] Bounded structures: `test/window.test.ts` — LRU eviction, iteration-safe snapshots, window pruning.
- [x] Mutation sanity (each mutant killed, then restored):
      `samples.length >= threshold` → `>` ⇒ 2 failures in `detectors.test.js`;
      `tokens > limit` → `>=` ⇒ 1 failure in `budget.test.js`;
      dedupe removed in `shouldWarn` ⇒ 1 failure in `guard.test.js`.

## Gate 3 — L2 integration (fake host, no network)

- [x] `test/adapter.test.ts` — the three hooks are registered; a loop interrupts exactly once; the report
      exists when the kill hook returns; clean sessions write on cleanup; dry-run never interrupts;
      invalid config disables the guard with one logged error; malformed events are ignored; idle and
      failed interrupts are logged.
- [x] `test/report.test.ts` — JSON/Markdown content, escaping, atomic write, path containment.
- [x] `test/cli.test.ts` — doctor (valid/invalid/missing/malformed config, JSON output), replay (clean,
      loop, warn, dry-run, bad JSON with line number, bad event, missing file, markdown output, blank
      lines), exit codes.
- [x] Token values are labelled `"source": "estimate"` in every report; asserted in `test/report.test.ts`.

## Gate 4 — L3 end-to-end (real OpenCode, mock provider)

- [x] `node scripts/e2e-mock-provider.mjs`:
      `PASS: real OpenCode session stopped by the guard with a written report`.
      Report: `stopped: true`, `reason: loop: tool_repeat …`, `events: {tool: 3, model: 2}`,
      `tokens_est.value: 4479`.
- [x] Exit codes: `0` ok, `1` config, `2` input/usage, `3` triggered — asserted in `test/cli.test.ts`,
      `scripts/smoke.mjs` and the README.
- [x] CLI bin from the packed tarball: `./node_modules/.bin/opencode-budget-guard --version` → `0.1.0`.

## Gate 5 — L5 adversarial

- [x] Threshold 0 ⇒ fires on the first sample; with `on_loop: kill` the replay exits 3.
- [x] Budget 0 ⇒ first context event kills; report shows the breach.
- [x] 1 MiB line ⇒ exit 2 with the line number; invalid UTF-8 ⇒ JSON error with the line number;
      a directory as `--events` ⇒ exit 2, no crash.
- [x] DAG bomb, 5,000-level chain, circular input, 4 MiB string, lone surrogates, control characters.
- [x] 20,000-event replay and 50,000 repeated calls keep bounded state (50 loop entries, no growth).
- [x] Interleaved sessions in one stream stay independent.

## Gate 6 — Honesty & mock-only audit

- [x] README has an explicit limitations section, including #27167 absorption risk and the estimate
      caveat.
- [x] No live API keys anywhere: tests use a fake host, the e2e uses a local mock server with a dummy key
      (allowlisted in the secrets scan). CI runs no network-dependent tests.
- [x] No "native"/"official" claims; the README calls it a community plugin.
- [x] No TODO/FIXME in `src/` (`grep -rn "TODO\|FIXME" src` returns nothing).
- [x] Secrets scan: `detect_secrets 1.5.0` over all 46 project files plus root config/docs → 0 findings.

## Gate 7 — L4 clean environment

- [x] Fresh copy (excluding `node_modules`, `dist`, `build-test`) → `npm ci` (276 packages) →
      `npm run check` → 142 tests pass, smoke checks pass.
- [x] README quickstart commands executed in the fresh copy (`doctor`, `replay` with a fixture).

## Gate 8 — Packaging (G3-gated; not executed)

- [x] `npm pack` → `opencode-budget-guard-0.1.0.tgz`, 35.4 kB, 63 files; `npm publish --dry-run` passes
      `prepublishOnly` (`npm run check`).
- [x] npm name free: registry returns 404 for `opencode-budget-guard` (2026-10-26).
- [x] Trademark posture: community plugin, no OpenCode marks in the name beyond the descriptive prefix.
- [ ] Publish to npm — **blocked on the G3 approval**; re-check competitors immediately before publishing.

## Definition of done (v0.1)

Gates 0–7 green with the evidence above; Gate 8 prepared but not executed.
