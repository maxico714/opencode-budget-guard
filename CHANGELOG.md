# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-10-26

### Added

- OpenCode 2 plugin (`{ id: "budget-guard", setup }`) using `execute.before`, `execute.after` and the
  session `context` hook; zero runtime dependencies.
- Detectors: `tool_repeat`, `identical_fail`, `oscillation`, each with a sliding window, configurable
  threshold and bounded memory.
- Budgets: `max_tokens_est` (estimate), `max_wall_seconds`, `max_consecutive_failures`; breaches always
  stop the session.
- Kill-switch with `on_loop: warn|kill`, `dry_run`, warning dedupe, and a synchronous report write
  before `session.interrupt`.
- Session reports in JSON and Markdown, written atomically inside the session directory.
- CLI: `doctor` (config validation, report-path writability, `--json`) and `replay` (JSONL streams with
  `--json`, `--markdown`, `--dry-run`), exit codes `0/1/2/3`.
- Fixtures for clean, loop and budget scenarios; examples for plugin options and in-process replay.
- Adversarial coverage: 1 MiB replay line cap, invalid UTF-8, directory input, DAG/deep/circular inputs,
  20k and 50k event volumes, zero thresholds.
- `scripts/e2e-mock-provider.mjs`: real OpenCode session against a local OpenAI-compatible mock server.

### Notes

- Token counts are estimates (`ceil(chars/4)`); provider billing data is not exposed to plugins.
- Wall-clock budgets are evaluated when an event arrives (no timer).
- Published to GitHub only; no npm release yet.

[Unreleased]: https://github.com/maxico714/opencode-budget-guard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/maxico714/opencode-budget-guard/releases/tag/v0.1.0
