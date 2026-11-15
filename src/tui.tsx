import { Plugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"
import { parseEvery, jitter, type TaskConfig } from "./schedule.js"
import { readLastOutcome, costUSD, formatMinutes } from "./runner.js"

interface TuiOptions {
  tasks?: TaskConfig[]
}

export default Plugin.define({
  id: "task-scheduler",
  setup(context) {
    const { client, data, ui, attention, location, options } = context
    const tasks: TaskConfig[] = (options as TuiOptions)?.tasks ?? []

    // Running task state
    const running = new Map<string, {
      sessionID: string
      iteration: number
      deadlineMs: number
    }>()

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

    async function createTaskSession(task: TaskConfig, iteration: number): Promise<string> {
      const created = await client.session.create({
        id: `task-${task.id}-${iteration}-${Date.now()}`,
        title: `⏱ ${task.id} · run ${iteration}`,
        location: { directory: location?.directory ?? "/home/aisurvivor" },
      })
      return created.id
    }

    async function runTaskLoop(task: TaskConfig) {
      const everyMs = task.loop.every ? parseEvery(task.loop.every) : 0
      let iteration = 0

      if (task.loop.initialDelay) {
        await sleep(parseEvery(task.loop.initialDelay))
      }

      // Create ONE session for the entire run
      let sessionID: string
      try {
        sessionID = await createTaskSession(task, 1)
      } catch (err) {
        ui.toast.show({ title: `task-scheduler ${task.id}`, message: `Session create failed: ${err}`, variant: "error" })
        return
      }

      running.set(task.id, { sessionID, iteration: 0, deadlineMs: 0 })

      if (task.focus !== "never") {
        try {
          ui.tabs.focus(sessionID)
          ui.router.navigate({ type: "session", sessionID })
        } catch {}
      }

      const startedAt = Date.now()
      const deadlineMs = startedAt + task.budget.minutes * 60_000

      try {
        while (true) {
          iteration++
          const entry = running.get(task.id)
          if (!entry || entry.sessionID !== sessionID) break // stopped externally

          if (task.loop.maxIterations != null && iteration > task.loop.maxIterations) break
          if (Date.now() >= deadlineMs) {
            ui.toast.show({ title: `task-scheduler ${task.id}`, message: "Deadline reached", variant: "warning" })
            await attention.notify({
              title: `Task ${task.id} timed out`,
              message: `Deadline of ${task.budget.minutes} min reached`,
              notification: "always",
              sound: { name: "done", when: "always" },
            })
            break
          }

          const text = iteration === 1 ? task.prompt : (task.continuePrompt ?? `Continue. Iteration ${iteration}.`)
          const minsLeft = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 60_000))
          const fullText = `${text}\n\n[time left: ${minsLeft} min][iteration: ${iteration}]`

          await client.session.update({ sessionID, title: `⏱ ${task.id} · run ${iteration}` })
          await client.session.prompt({ sessionID, text: fullText, delivery: "steer" })

          try {
            await client.session.wait({ sessionID })
          } catch {
            await sleep(2_000)
          }

          const ctx = await client.session.context({ sessionID })
          const messages = ctx.data ?? []
          const { outcome, cost, tokens } = readLastOutcome(messages)
          const c = costUSD(cost)

          // Check cost budget
          if (task.budget.maxCostUSD != null && c >= task.budget.maxCostUSD) {
            ui.toast.show({ title: `task-scheduler ${task.id}`, message: "Cost budget reached", variant: "warning" })
            break
          }

          // Check max iterations
          if (iteration >= (task.loop.maxIterations || 999)) {
            ui.toast.show({ title: `task-scheduler ${task.id}`, message: "Max iterations reached", variant: "info" })
            break
          }

          // Sleep between iterations
          if (everyMs <= 0) continue
          await sleep(jitter(everyMs, 0.1))
        }

        // Task done
        await attention.notify({
          title: `Task ${task.id} finished`,
          message: `Iteration ${iteration} complete`,
          notification: "always",
          sound: { name: "done", when: "always" },
        })
        ui.toast.show({ title: `task-scheduler ${task.id}`, message: `Finished after ${iteration} iteration(s)`, variant: "success" })
      } finally {
        running.delete(task.id)
      }
    }

    // Arm startup tasks
    for (const task of tasks) {
      if (task.start === "startup") {
        void runTaskLoop(task).catch((err) => {
          ui.toast.show({ title: `task-scheduler ${task.id}`, message: `Error: ${err}`, variant: "error" })
          running.delete(task.id)
        })
      }
    }

    // Palette commands
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "task-scheduler.list",
          title: "Task scheduler: list tasks",
          palette: true,
          run: () => {
            const lines = tasks.map((t) => `- ${t.id} (${t.start}, every ${t.loop.every ?? "manual"})`).join("\n")
            ui.toast.show({ title: "task-scheduler", message: lines || "No tasks configured", variant: "info", duration: 10000 })
          },
        },
        {
          id: "task-scheduler.run",
          title: "Task scheduler: run a task",
          palette: true,
          slash: { name: "task", aliases: ["run"], arguments: true },
          run: async (input) => {
            const id = (input ?? "").trim()
            if (!id) {
              ui.toast.show({ title: "task-scheduler", message: "Usage: /task run <id>", variant: "info" })
              return
            }
            const task = tasks.find((t) => t.id === id)
            if (!task) {
              ui.toast.show({ title: "task-scheduler", message: `Unknown task: ${id}`, variant: "error" })
              return
            }
            if (running.has(task.id)) {
              ui.toast.show({ title: `task-scheduler ${task.id}`, message: "Already running", variant: "warning" })
              return
            }
            void runTaskLoop(task).catch((err) => {
              ui.toast.show({ title: `task-scheduler ${task.id}`, message: `Error: ${err}`, variant: "error" })
              running.delete(task.id)
            })
            ui.toast.show({ title: `task-scheduler ${task.id}`, message: "Started", variant: "success" })
          },
        },
        {
          id: "task-scheduler.stop",
          title: "Task scheduler: stop a task",
          palette: true,
          run: async (input) => {
            const id = (input ?? "").trim()
            if (!id) {
              ui.toast.show({ title: "task-scheduler", message: "Usage: /task stop <id>", variant: "info" })
              return
            }
            const entry = running.get(id)
            if (!entry) {
              ui.toast.show({ title: "task-scheduler", message: `No running task: ${id}`, variant: "info" })
              return
            }
            try {
              await client.session.interrupt({ sessionID: entry.sessionID })
            } catch {}
            running.delete(id)
            ui.toast.show({ title: `task-scheduler ${id}`, message: "Stopped", variant: "info" })
          },
        },
      ],
    }))

    return () => {
      footerUnsub()
      running.forEach((entry) => {
        void client.session.interrupt({ sessionID: entry.sessionID }).catch(() => {})
      })
      running.clear()
    }
  },
})

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
