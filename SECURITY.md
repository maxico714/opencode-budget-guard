# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |

## Reporting a vulnerability

Use GitHub's private "Report a vulnerability" form on the repository's Security tab. Do not open a
public issue for anything that could stop a session unexpectedly, escape the report directory, or
exhaust host memory.

Include the version (`opencode-budget-guard --version`), the OpenCode version, the platform, the
configuration (redact anything sensitive), and a minimal reproduction — a JSONL fixture is ideal. You can
expect an acknowledgement within seven days and a remediation plan or a reasoned decision within thirty
days.

## Threat model in brief

- **Untrusted events.** Tool inputs and errors come from a model. They are validated (`EventError`),
  hashed with depth and node caps (64 levels, 100k nodes, cycle marking) and never executed.
- **Bounded memory.** Sessions (64), samples per key (256), detector keys (4096 per detector) and logged
  entries (50) all have hard caps; the guard cannot be used to exhaust memory with a long session.
- **Report containment.** Report paths must be relative and stay inside the session directory; absolute
  paths and `..` escapes are rejected at config load and again before writing. Writes go through a
  temporary file and a rename.
- **What a report contains.** Session IDs, tool names, path strings the model used, normalised error
  signatures (first line, paths replaced, 200 characters), counts and timestamps. No prompts, message
  bodies or tool output. Treat reports like build logs.
- **Host authority.** The plugin runs inside the OpenCode process and can only call the documented host
  APIs it uses: three hooks and `session.interrupt`. It makes no network requests and collects no
  telemetry.
- **Supply chain.** Zero runtime dependencies; `@opencode/plugin` is a pinned dev dependency used only
  for types; CI actions are pinned to commit SHAs.

## Out of scope

- Behaviour of the agent before this plugin observes it (events that never arrive cannot be counted).
- Third-party providers, OpenCode itself, and anything you configure under `report.*` beyond the session
  directory.
