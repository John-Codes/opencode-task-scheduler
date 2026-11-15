import { Plugin } from "@opencode/plugin"
import type { TaskConfig } from "./schedule.js"

interface PluginOptions {
  tasks?: TaskConfig[]
}

export default Plugin.define({
  id: "task-scheduler",
  async setup(ctx) {
    const options = (ctx.options as PluginOptions) ?? {}
    const tasks: TaskConfig[] = (options.tasks ?? [])

    // Persist tasks to storage
    await ctx.storage.set("task-scheduler:config", {
      tasks,
      at: Date.now(),
    })

    return () => {}
  },
})
