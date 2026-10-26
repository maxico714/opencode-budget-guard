// Portable CLI smoke check: doctor must pass, a clean stream must exit 0 and a loop
// stream must exit 3 (triggered). Used by CI on every OS.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const cli = resolve(repo, "dist", "cli.js");

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: "utf8" });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

const checks = [
  { name: "doctor", args: ["doctor"], expected: 0 },
  { name: "clean stream", args: ["replay", "--events", "fixtures/no-loop/clean.jsonl"], expected: 0 },
  {
    name: "loop stream",
    args: ["replay", "--events", "fixtures/loops/tool-repeat.jsonl", "--config", "fixtures/config/tight.json"],
    expected: 3,
  },
];

let failed = 0;
for (const check of checks) {
  const result = run(check.args);
  const ok = result.code === check.expected;
  if (!ok) failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${check.name}: exit ${result.code} (expected ${check.expected})`);
  if (!ok) console.log(result.err);
}

if (failed > 0) {
  console.error(`${failed} smoke check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("smoke checks passed");
}
