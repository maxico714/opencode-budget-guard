// Portable test entry: Node 20 does not expand globs in `--test`, and Node 24 no longer
// accepts a directory, so resolve the compiled test files here.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(repo, "build-test", "test");

let names;
try {
  names = readdirSync(testDir);
} catch {
  console.error(`missing ${testDir}; run tsc -p tsconfig.test.json first`);
  process.exit(1);
}

const files = names
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join(testDir, name));

if (files.length === 0) {
  console.error(`no test files in ${testDir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
