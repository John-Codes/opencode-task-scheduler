import { Plugin } from "@opencode/plugin"
import { TaskEngine } from "./engine.js"
import type { TaskConfig } from "./schedule.js"

interface PluginOptions {
  tasks?: TaskConfig[]
}

export default Plugin.define({
  id: "task-scheduler",
  async setup(ctx) {
    const options = (ctx.options as PluginOptions) ?? {}
    const tasks: TaskConfig[] = (options.tasks ?? []).map((t) => ({
      id: t.id,
      start: t.start ?? "manual",
      session: t.session ?? "new",
      focus: t.focus ?? "on-start",
      prompt: t.prompt,
      continuePrompt: t.continuePrompt,
      agent: t.agent,
      model: t.model,
      loop: {
        kind: t.loop?.kind ?? "while",
        every: t.loop?.every,
        until: t.loop?.until ?? { kind: "agent" },
        maxIterations: t.loop?.maxIterations,
        items: t.loop?.items,
        initialDelay: t.loop?.initialDelay,
        catchUp: t.loop?.catchUp,
      },
      budget: {
        minutes: t.budget?.minutes ?? 30,
        maxTotalMinutes: t.budget?.maxTotalMinutes ?? null,
        maxExtensions: t.budget?.maxExtensions ?? 3,
        maxCostUSD: t.budget?.maxCostUSD ?? null,
        maxSteps: t.budget?.maxSteps ?? null,
        onTimeout: t.budget?.onTimeout ?? "interrupt",
        autoApprove: t.budget?.autoApprove ?? false,
        deny: t.budget?.deny ?? [],
      },
      permissions: t.permissions,
    }))

    const engine = new TaskEngine(ctx as any, tasks)
    const cleanup = await engine.setup()

    // Expose engine on ctx for the TUI part to find via plugin list? Not directly.
    // Instead, state lives in ctx.storage; TUI reads it from storage.

    return cleanup
  },
})
