# Fixtures

Recorded JSONL event streams and configs used by tests, the README and the CLI smoke check. Every
fixture uses the timestamp base `1_700_000_000_000` and a single session ID.

| File | Config | Expected result |
|---|---|---|
| `no-loop/clean.jsonl` | defaults | exit 0, `no trigger`, 6 model calls, 12 tool events |
| `loops/tool-repeat.jsonl` | `config/tight.json` | exit 3, `tool_repeat` stops the session at the 3rd identical call |
| `loops/identical-fail.jsonl` | `config/tight.json` | exit 3, `identical_fail` stops the session at the 2nd identical error |
| `loops/oscillation.jsonl` | `config/tight.json` | exit 3, `oscillation` stops the session at the first A→B→A alternation |
| `budgets/token-budget.jsonl` | `config/budget.json` | exit 3, `max_tokens_est=30000 > 20000` |

| Config | Purpose |
|---|---|
| `config/tight.json` | low detector thresholds with `on_loop: kill` |
| `config/budget.json` | a token budget the budget fixture exceeds |
| `config/warn.json` | default thresholds with `on_loop: warn` |

Run any of them:

```console
$ opencode-budget-guard replay --events fixtures/loops/tool-repeat.jsonl --config fixtures/config/tight.json
```

The identical-fail fixture writes a Windows path in the error message on purpose: the report shows the
same signature as a POSIX path would, because paths are normalised before comparison.
