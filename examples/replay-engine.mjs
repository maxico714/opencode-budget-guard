// Run the guard over an event stream in-process, without the CLI.
// Usage: node examples/replay-engine.mjs fixtures/loops/tool-repeat.jsonl
import { readFile } from "node:fs/promises";

import { Guard, resolveConfig, reportToMarkdown } from "../dist/engine.js";

const path = process.argv[2] ?? "fixtures/loops/tool-repeat.jsonl";
const config = resolveConfig({ on_loop: "kill", report: { json: null, markdown: null } });
const guard = new Guard(config);

for (const [index, raw] of (await readFile(path, "utf8")).split("\n").entries()) {
  if (raw.trim() === "") continue;
  let event;
  try {
    event = JSON.parse(raw);
  } catch (error) {
    console.error(`line ${index + 1}: ${error.message}`);
    process.exitCode = 2;
    break;
  }
  const decision = guard.ingest(event);
  if (decision.action !== "none") console.log(`line ${index + 1}: ${decision.action}`, decision);
}

for (const report of guard.snapshotAll()) {
  console.log(reportToMarkdown(report));
}
