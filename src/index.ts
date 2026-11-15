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
      const tasks: TaskConfig[] = (options.tasks ?? [])

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

      return cleanup
    } catch (err) {
      await ctx.storage.set("task-scheduler:setup-log", {
        event: "setup-failed",
        error: String(err),
        stack: (err as Error)?.stack,
        at: Date.now(),
      })
      throw err
    }
  },
})
