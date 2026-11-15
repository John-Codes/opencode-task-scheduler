import { Plugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"
import { formatMinutes } from "./runner.js"

export default Plugin.define({
  id: "task-scheduler",
  setup(context) {
    const { client, ui, attention, options } = context

    // Read tasks from config (stored by server part)
    const tasks: any[] = (options as any)?.tasks ?? []

    // Running state read from storage
    const running = new Map<string, { sessionID: string; iteration: number; deadlineMs: number }>()

    // Footer status slot
    const footerUnsub = ui.slot({
      append: "home.footer.status",
      render: () => {
        const active = [...running.entries()].map(([tid, r]) => {
          const minsLeft = Math.max(0, Math.ceil((r.deadlineMs - Date.now()) / 60_000))
          return `${tid} · run ${r.iteration} · ${minsLeft}m left`
        })
        if (active.length === 0) return <text>task-scheduler idle</text>
        return <text>{active.join(" · ")}</text>
      },
    })

    // Poll storage for run events and update running map
    const pollInterval = setInterval(async () => {
      try {
        for (const task of tasks) {
          const event = await client.storage.get(`task-scheduler:last-event:${task.id}`)
          if (event) {
            // Update running state
            const existing = running.get(task.id)
            if (existing) {
              existing.iteration = event.runIndex
              existing.deadlineMs = Date.now() + task.budget.minutes * 60_000
            }
          }
        }
      } catch {}
    }, 2000)

    // Palette command: list tasks
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "task-scheduler.list",
          title: "Task scheduler: list tasks",
          palette: true,
          run: () => {
            const lines = tasks.map((t) => `- ${t.id} (${t.start}, every ${t.loop?.every ?? "manual"})`).join("\n")
            ui.toast.show({ title: "task-scheduler", message: lines || "No tasks configured", variant: "info", duration: 10000 })
          },
        },
      ],
    }))

    return () => {
      footerUnsub()
      clearInterval(pollInterval)
      running.forEach((entry) => {
        void client.session.interrupt({ sessionID: entry.sessionID }).catch(() => {})
      })
      running.clear()
    }
  },
})
