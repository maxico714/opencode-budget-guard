import type { Plugin } from "@opencode/plugin";

import { attach } from "./adapter.js";

/**
 * OpenCode 2 reads `id` and `setup` from the default export (see docs/PLUGIN_API.md).
 * The definition is written structurally so the published package imports nothing at
 * runtime; `satisfies` keeps it checked against the real host types.
 */
const plugin = {
  id: "budget-guard",
  async setup(ctx: Plugin.Context) {
    const attached = attach(ctx);
    await attached.ready;
    return () => attached.cleanup();
  },
} satisfies Plugin.Plugin;

export default plugin;
