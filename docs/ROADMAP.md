# ROADMAP — opencode-budget-guard

Status: v0.1.0 built and verified (2026-10-26). SemVer, Keep a Changelog.
Absorption risk: OpenCode #27167 may land a native feature; the README states this honestly.

## v0.1 — Walking skeleton (done)

- [x] Gate 0: OpenCode 2.1.2 plugin hooks read from installed types and upstream source; frozen in
      `docs/PLUGIN_API.md`.
- [x] Detectors: `tool_repeat`, `identical_fail`, `oscillation` with sliding windows and bounded memory.
- [x] Budgets: estimated tokens, wall-clock, consecutive failures.
- [x] Kill-switch: warn/kill escalation, `session.interrupt`, JSON + Markdown report.
- [x] Mock provider: in-process fake host (L2) and a real OpenCode session against a local
      OpenAI-compatible mock server (L3, `scripts/e2e-mock-provider.mjs`).
- [x] JSON config, `doctor`, `replay`, `--dry-run`, README quickstart, SHA-pinned CI.
- [x] Adversarial coverage: 1 MiB line cap, invalid UTF-8, DAG bomb, deep chains, circular inputs,
      20k-event replay, zero thresholds.

**Riskiest assumption, now retired:** that the plugin API shape was what the scaffold guessed. It was
not — see `docs/PLUGIN_API.md` for the differences (plural `plugins` key, directory-only local paths,
`execute.before/after` payloads, `session.interrupt`).

## v0.5 — Core value

- [ ] Per-tool token attribution (still an estimate; label it clearly).
- [ ] Detector tuning guides derived from real recordings (publish anonymised fixtures).
- [ ] Markdown report tailored for CI artefacts (summary table, links to the first offending event).
- [ ] Quarterly re-check of #27167 and of neighbouring plugins; update the README comparison honestly.
- [ ] Optional metrics endpoint for long-running jobs (explicit opt-in, local only).

## v1.0 — Production-ready

- [ ] Registry publish (requires the G3 gate) with provenance and a signed build.
- [ ] SBOM in releases; THIRD_PARTY_NOTICES kept current by CI.
- [ ] Verified on macOS and Linux, and against the oldest supported OpenCode 2.x release.
- [ ] Config schema published for editors (`$schema` in `opencode.json(c)`).

## Post-1.0 (parked)

- Cost dashboards, model routing, GUI. Out of scope by design: the plugin is a circuit breaker, not a
  billing product.

## Maintenance cadence

- OpenCode API churn: the hook layer is one file (`src/adapter.ts`); a breaking change is a patch.
- Detector defaults: config data, not code paths; changes ship as minor versions.
