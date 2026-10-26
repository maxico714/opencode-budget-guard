# PLUGIN_API — verified against OpenCode 2.1.2

Gate 0 of `BUILD_CHECKLIST.md` required the exact hook surface rather than assumptions. Everything
below was read from installed type definitions or the upstream documentation source on **2026-10-26**.
Anything not confirmed that way is marked `[ASSUMED]` or `[UNKNOWN]`.

## Sources

| Source                                                                         | Version / commit   | What it established                                                                                               |
| ------------------------------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `@opencode/plugin` on npm (`node_modules/@opencode/plugin/dist/**/*.d.ts`)     | 2.1.2              | Runtime types: `Context`, `Plugin`, hook payloads, `interrupt` input/response                                     |
| `@opencode/cli` on npm, installed binary strings                               | 2.1.2              | `execute.before` / `execute.after` hook names exist in the shipped binary                                         |
| `anomalyco/opencode` → `services/www/src/docs/content/build/plugins/index.mdx` | fetched 2026-10-26 | Loading rules (`plugins` key, local directories), publish requirements, V1/V2 export rules                        |
| `anomalyco/opencode` → `packages/core/src/plugin/supervisor.ts`, `module.ts`   | fetched 2026-10-26 | Target resolution: absolute path = local, anything else = npm install; local directories resolve `server`/`index` |
| `https://opencode.ai/docs/plugins/`                                            | fetched 2026-10-26 | Public docs page still describes the V1 function-plugin shape                                                     |

## Package shape

`Plugin.define` is an identity helper; V2 reads `id` and `setup` from the default export.

```ts
// node_modules/@opencode/plugin/dist/promise/plugin.d.ts
export interface Plugin {
  readonly id: string;
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void;
}
export declare function define(plugin: Plugin): Plugin;
```

The published package therefore exports a plain object typed with `satisfies Plugin.Plugin`
(`src/plugin.ts`). That keeps the runtime dependency count at zero while still compiling against the
real host types: if OpenCode changes the contract, `npm run typecheck` fails.

```ts
export default {
  id: "budget-guard",
  async setup(ctx) {
    /* register hooks, return cleanup */
  },
};
```

## Loading rules (V2)

- Local directories under `.opencode/plugins/<name>/` load automatically.
- Published packages and other locations go in `plugins` (plural) in `opencode.json(c)`:

```jsonc
{
  "plugins": [
    "opencode-acme-plugin",
    { "package": "@acme/opencode-plugin", "options": { "strict": true } },
    "/absolute/path/plugin",
    "./plugins/local",
  ],
}
```

- Only **absolute** paths are treated as local. Relative paths and bare names are resolved through
  npm, which means a package that is not published to a registry fails with
  `NpmInstallFailedError` even if it is already present in `node_modules`.
- A local directory is resolved by looking for a root `server` entry and then `index`
  (`packages/core/src/plugin/module.ts` → `Host.resolve`). Package `exports` are **not** consulted for
  directory targets, which is why this package ships a root `index.js` in addition to `dist/`.
- `options` from the object form arrive as `ctx.options` (`Readonly<Record<string, any>>`).
  `@opencode/plugin` types this as `PluginOptions`; this plugin validates it at runtime instead of
  trusting it.

## Hooks used

| Hook                                  | Payload (verified fields)                                                                        | What the guard does                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `ctx.tool.hook("execute.before", cb)` | `tool`, `sessionID`, `agent`, `messageID`, `id`, `input`                                         | Records `tool.start` (tool name + stable input hash + path)       |
| `ctx.tool.hook("execute.after", cb)`  | the same fields plus `status: "completed" \| "error"`; `Tool.Error` carries `message`            | Records `tool.end`, feeds the identical-failure detector          |
| `ctx.session.hook("context", cb)`     | `sessionID`, `model`, `system: SystemPart[]`, `messages: Message[]`, `options`, `agent`, `tools` | Estimates tokens from `JSON.stringify([system, messages]).length` |

Registration returns a `Registration` with `dispose()`. The adapter keeps the registrations alive for
the plugin lifetime and relies on the setup cleanup to persist the final report.

```ts
// node_modules/@opencode/plugin/dist/promise/tool.d.ts (abridged)
readonly "execute.after": {
  readonly tool: string;
  readonly sessionID: Session.ID;
  readonly input: unknown;
} & ({ readonly status: "completed" } | { readonly status: "error"; error: Tool.Error });
```

## Stopping a session

```ts
await ctx.session.interrupt({ sessionID, resume: false }); // → { interrupted: boolean }
```

`SessionInterruptInput` is `{ sessionID: string; resume?: boolean }` and the response is
`{ interrupted: boolean }` (`@opencode/client/dist/promise/generated/types.d.ts`). The guard calls it
after writing the report; `resume: false` leaves the session idle rather than restarting the agent.

Observed in a real session: the in-flight tool call ends with `Tool execution interrupted` and the step
is aborted (`Step interrupted`). The CLI process exits non-zero, which is expected for a killed
session.

## What this plugin does not rely on

- No provider usage object is used for token counts: tool results and context hooks do not expose
  billed usage, so the guard reports an explicit estimate (`ceil(chars/4)`).
- No event bus subscription: the guard only needs the three hooks above.
- No assumptions about model, provider or agent names; every event is keyed by `sessionID`.

## Not verified

- Effect-style plugins (`effect()` export) and the RPC/TUI entrypoints.
- OpenCode 1.x compatibility. The package targets V2 only; the upstream docs describe a dual-export
  pattern if V1 support is needed later.
- Behaviour on macOS/Linux hosts. All evidence here is from Windows 10 (26200) with OpenCode 2.1.2.
