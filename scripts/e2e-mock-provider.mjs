// End-to-end check: a real OpenCode session against a local mock model server.
//
// The mock server speaks the OpenAI chat-completions protocol and always asks for the
// same `shell` call, so the guard must stop the session after `tool_repeat` reaches its
// threshold. No network access and no API keys are involved beyond a dummy value.
//
// Usage: node scripts/e2e-mock-provider.mjs [--keep]
// Env:   OPENCODE_BIN  path to the opencode executable (default: "opencode")
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
let keep = process.argv.includes("--keep");
const opencodeBin = process.env.OPENCODE_BIN ?? "opencode";
const TIMEOUT_MS = 180_000;

const toolCall = {
  id: "call_guard_1",
  type: "function",
  function: {
    name: "shell",
    arguments: JSON.stringify({ command: "echo budget-guard loop", description: "repeat forever" }),
  },
};

function completionBody() {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "echo",
    choices: [
      { index: 0, message: { role: "assistant", content: null, tool_calls: [toolCall] }, finish_reason: "tool_calls" },
    ],
    usage: { prompt_tokens: 64, completion_tokens: 16, total_tokens: 80 },
  };
}

function completionChunks() {
  const base = {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "echo",
  };
  const first = {
    ...base,
    choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }],
  };
  const last = { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
  return [`data: ${JSON.stringify(first)}`, "", `data: ${JSON.stringify(last)}`, "", "data: [DONE]", ""].join("\n");
}

function startServer() {
  const state = { requests: 0, model: "echo" };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const url = request.url ?? "/";
      if (request.method === "GET" && url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ object: "list", data: [{ id: state.model, object: "model", owned_by: "mock" }] }),
        );
        return;
      }
      if (request.method === "POST" && url.endsWith("/chat/completions")) {
        state.requests += 1;
        let wantsStream = false;
        try {
          wantsStream = JSON.parse(body).stream === true;
        } catch {
          wantsStream = false;
        }
        if (wantsStream) {
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          response.end(completionChunks());
        } else {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(completionBody()));
        }
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `mock server: unsupported ${request.method} ${url}` } }));
    });
  });
  return new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveReady({ server, state, port: server.address().port }));
  });
}

function run(commandLine, options = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(commandLine, { ...options, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveRun({ code: null, timeout: true, stdout, stderr });
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ code: null, error: String(error), stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, timeout: false, stdout, stderr });
    });
  });
}

function runShell(commandLine, options) {
  return run(commandLine, options);
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), "budget-guard-e2e-"));
  const project = join(work, "project");
  const { server, state, port } = await startServer();
  try {
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "e2e", private: true, type: "module" }, null, 2),
    );

    const pack = await runShell(`npm pack --pack-destination "${work}" --silent`, { cwd: repo });
    if (pack.code !== 0) {
      throw new Error(`npm pack failed (code ${pack.code}): ${pack.stderr || pack.stdout || pack.error}`);
    }
    const tarball = join(work, (pack.stdout.trim().split(/\r?\n/).pop() ?? "").trim());
    const install = await runShell(`npm install --no-audit --no-fund --ignore-scripts "${tarball}"`, {
      cwd: project,
    });
    if (install.code !== 0) throw new Error(`npm install failed: ${install.stderr || install.error}`);

    const pluginDir = join(project, "plugins", "budget-guard");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "index.js"), 'export { default } from "opencode-budget-guard";\n');

    const config = {
      $schema: "https://opencode.ai/config.json",
      providers: {
        mock: {
          name: "Mock",
          env: ["MOCK_API_KEY"],
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${port}/v1` },
          models: { echo: { name: "Echo (mock)" } },
        },
      },
      plugins: [
        {
          // Configured local plugins must be directories with a root `index`/`server`
          // entry; bare names are installed from the registry (a separate gate).
          package: pluginDir.replaceAll("\\", "/"),
          options: {
            detectors: { tool_repeat: { threshold: 2, window_seconds: 120 } },
            budgets: { max_tokens_est: 10_000_000, max_wall_seconds: 600, max_consecutive_failures: 1000 },
            on_loop: "kill",
            report: { json: ".budget-guard/report.json", markdown: ".budget-guard/report.md" },
          },
        },
      ],
    };
    const configPath = join(work, "opencode.jsonc");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const env = {
      ...process.env,
      // Bash exports PWD, and the CLI prefers it over the real working directory.
      PWD: project,
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: join(work, "config"),
      OPENCODE_DB: join(work, "state.db"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      MOCK_API_KEY: "dummy-local-key", // pragma: allowlist secret - value is not a credential
    };
    const started = Date.now();
    const session = await runShell(
      `"${opencodeBin}" run --standalone --print-logs --log-level debug --model mock/echo --auto --format json "Repeat the shell command."`,
      { cwd: project, env },
    );
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    const reportPath = join(project, ".budget-guard", "report.json");
    let report = null;
    // The plugin runs inside the server subprocess, which can finish its shutdown
    // slightly after the `run` process exits.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        report = JSON.parse(await readFile(reportPath, "utf8"));
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      }
    }
    if (report === null) report = { missing: true };
    const stopped = report.stopped === true;
    const looped = Array.isArray(report.loops) && report.loops.some((item) => item.detector === "tool_repeat");
    const passed = stopped && looped && !session.timeout;

    console.log(`opencode: ${opencodeBin}`);
    console.log(`mock requests: ${state.requests}`);
    console.log(`session exit: ${session.code} (timeout=${session.timeout}) in ${elapsed}s`);
    console.log(`report: stopped=${String(stopped)} loops=${JSON.stringify(report.loops ?? null)}`);
    if (!passed) {
      console.log("--- session stdout (tail) ---");
      console.log(session.stdout.slice(-4000));
      console.log("--- session stderr (tail) ---");
      console.log(session.stderr.slice(-4000));
      console.log(`work dir kept at ${work}`);
      keep = true;
      process.exitCode = 1;
      return;
    }
    console.log("PASS: real OpenCode session stopped by the guard with a written report");
  } catch (error) {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`work dir kept at ${work}`);
    keep = true;
    process.exitCode = 1;
  } finally {
    server.close();
    if (keep) console.log(`kept ${work}`);
    else await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
