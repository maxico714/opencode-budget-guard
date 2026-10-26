# Contributing

Thanks for taking a look. This is a small plugin; the fastest useful contribution is a reproducible loop
recording or a clear false-positive report.

## Setup (under five minutes)

```console
$ git clone https://github.com/maxico714/opencode-budget-guard
$ cd opencode-budget-guard
$ npm ci
$ npm run check
```

`npm run check` runs the build, type check, linter, formatter check and the test suite (Node's built-in
`node:test`, compiled into `build-test/`). Node.js 20 or newer is required; CI covers 20, 22 and 24 on
Ubuntu and Windows.

## Optional end-to-end run

`node scripts/e2e-mock-provider.mjs` packs the repo, installs the tarball into a temp project, starts a
local OpenAI-compatible mock server, runs a real OpenCode session with `--standalone`, and asserts that
the guard stopped it and wrote a report. It needs `opencode` on `PATH` (or `OPENCODE_BIN`) and makes no
external network calls.

## Guidelines

- Every behaviour change needs a test that fails without the change. For detector or budget changes, add
  a mutation check to the pull request notes: break the condition locally, show the test failing, restore.
- Keep the runtime dependency count at zero. Dev-only tooling is fine if it is pinned in
  `package-lock.json`.
- Detectors must stay bounded: no unbounded arrays, maps or per-session growth. Use `window.ts` helpers.
- Reports must not gain prompt text, message bodies or tool output. Paths, tool names and normalised
  error signatures are the intended maximum.
- Update `README.md`, `docs/TECHNICAL.md` and `CHANGELOG.md` in the same pull request when behaviour,
  defaults or limits change.

## Commits and pull requests

- Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- One logical change per pull request; describe the failure you observed and the command that proves the
  fix.
- CI must be green. Formatting is enforced: run `npm run format` before pushing.

## Reporting loops (the good kind)

If your agent entered a loop and the guard did not fire, a redacted recording helps. `opencode-budget-guard replay`
accepts JSONL where each line is one of:

```json
{"type":"tool.start","sessionID":"s","tool":"edit","input":{"filePath":"src/a.ts"},"ts":1700000000000}
{"type":"tool.end","sessionID":"s","tool":"edit","input":{"filePath":"src/a.ts"},"status":"error","error":"ENOENT","ts":1700000001000}
{"type":"model.context","sessionID":"s","chars":4000,"ts":1700000002000}
```

Remove anything sensitive from `input` before sharing; the guard only hashes it.
