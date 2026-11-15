import { Plugin } from "@opencode/plugin"
import { TaskEngine } from "./engine.js"
import type { TaskConfig } from "./schedule.js"

interface PluginOptions {
  tasks?: TaskConfig[]
}

export default Plugin.define({
  id: "task-scheduler",
  async setup(ctx) {
    try {
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

      await ctx.storage.set("task-scheduler:setup-log", {
        event: "setup-started",
        taskCount: tasks.length,
        taskIds: tasks.map((t) => t.id),
        at: Date.now(),
      })

      const engine = new TaskEngine(ctx as any, tasks)
      const cleanup = await engine.setup()

      await ctx.storage.set("task-scheduler:setup-log", {
        event: "setup-completed",
        taskCount: tasks.length,
        at: Date.now(),
      })

      // Test: create a session immediately to verify plugin session API works
      try {
        const test = await ctx.session.create({
          id: `task-scheduler-setup-test-${Date.now()}`,
          title: "⏱ setup test session",
          location: { directory: ctx.location.directory },
        })
        await ctx.storage.set("task-scheduler:setup-log", {
          event: "setup-test-session-created",
          sessionID: test.id,
          at: Date.now(),
        })
        await ctx.session.prompt({
          sessionID: test.id,
          text: "Reply with exactly: SETUP_TEST_OK",
          delivery: "steer",
        })
        await ctx.storage.set("task-scheduler:setup-log", {
          event: "setup-test-prompt-sent",
          sessionID: test.id,
          at: Date.now(),
        })
      } catch (err) {
        await ctx.storage.set("task-scheduler:setup-log", {
          event: "setup-test-failed",
          error: String(err),
          stack: (err as Error)?.stack,
          at: Date.now(),
        })
      }

      return cleanup
    } catch (err) {
      await ctx.storage.set("task-scheduler:setup-log", {
        event: "setup-failed",
        error: String(err),
        at: Date.now(),
      })
      throw err
    }
  },
})
