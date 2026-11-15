import { Plugin } from "@opencode/plugin"
import { TaskStore } from "./state.js"
import { readLastOutcome, costUSD, tokensUsed, formatMinutes } from "./runner.js"
import { parseEvery, jitter, type TaskConfig, type Until } from "./schedule.js"

interface RunCtx {
  task: TaskConfig
  sessionID: string
  startedAt: number
  deadlineMs: number
}

export class TaskEngine {
  private locks = new Set<string>()
  private runs = new Map<string, RunCtx>()

  constructor(
    private ctx: {
      session: {
        create: (input: { id?: string; title?: string; location?: { directory: string } }) => Promise<{ id: string }>
        prompt: (input: { sessionID: string; text: string; delivery?: "steer" | "queue" }) => Promise<any>
        wait: (input: { sessionID: string }) => Promise<void>
        interrupt: (input: { sessionID: string }) => Promise<{ interrupted: boolean }>
        update: (input: { sessionID: string; title?: string }) => Promise<void>
        context: (input: { sessionID: string }) => Promise<{ data: any[] }>
      }
      command: {
        transform: (cb: (editor: { add: (d: { name: string; description?: string; execute: (i: any) => Promise<void> }) => void }) => void) => Promise<{ dispose: () => Promise<void> }>
        reload: () => Promise<void>
      }
      storage: { get: (k: string) => Promise<any>; set: (k: string, v: any) => Promise<void> }
      location: { directory: string }
    },
    private tasks: TaskConfig[],
  ) {
    this.store = new TaskStore(ctx.storage)
  }

  private store: TaskStore

  async setup() {
    await this.ctx.command.transform((editor) => {
      editor.add({
        name: "task",
        description: "Manage scheduled agentic tasks",
        execute: async ({ sessionID, prompt }) => {
          await this.handleCommand(sessionID, prompt)
        },
      })
    })
    await this.ctx.command.reload()

    for (const task of this.tasks) {
      if (task.start === "startup") this.arm(task)
    }

    return () => this.teardown()
  }

  teardown() {
    this.locks.clear()
    this.runs.clear()
  }

  private async log(taskID: string, event: string, data: any) {
    await this.ctx.storage.set(`task-scheduler:log:${taskID}:${Date.now()}`, {
      taskID, event, data, at: Date.now(),
    })
  }

  private arm(task: TaskConfig) {
    if (this.locks.has(task.id)) return
    this.locks.add(task.id)
    void this.runLoop(task).catch((err) => {
      void this.ctx.storage.set(`task-scheduler:error:${task.id}`, {
        taskID: task.id,
        error: String(err),
        stack: (err as Error)?.stack,
        at: Date.now(),
      })
      this.locks.delete(task.id)
    })
  }

  private async runLoop(task: TaskConfig) {
    await this.log(task.id, "runLoop-entered", { every: task.loop.every, maxIterations: task.loop.maxIterations })
    const everyMs = task.loop.every ? parseEvery(task.loop.every) : 0
    let iteration = 0

    if (task.loop.initialDelay) {
      await sleep(parseEvery(task.loop.initialDelay))
    }

    while (true) {
      iteration++
      if (task.loop.maxIterations != null && iteration > task.loop.maxIterations) break

      let sessionID: string
      try {
        if (task.session === "new") {
          const created = await this.ctx.session.create({
            id: `task-${task.id}-${iteration}-${Date.now()}`,
            title: `⏱ ${task.id} · run ${iteration}`,
            location: { directory: this.ctx.location.directory },
          })
          sessionID = created.id
          await this.log(task.id, "session-created", { sessionID, iteration })
        } else {
          sessionID = sessionID // will be set below
        }
      } catch (err) {
        await this.ctx.storage.set(`task-scheduler:error:${task.id}`, {
          taskID: task.id,
          iteration,
          error: `session.create failed: ${String(err)}`,
          stack: (err as Error)?.stack,
          at: Date.now(),
        })
        throw err
      }

      // For session:"current", we need the calling sessionID - but runLoop doesn't have it.
      // We'll handle this in handleCommand instead.
      break // placeholder - actual logic in handleCommand
    }

    this.locks.delete(task.id)
  }

  private async handleCommand(sessionID: string, prompt: { text?: string }) {
    const args = (prompt.text ?? "").trim().split(/\s+/)
    const verb = args[0]
    const id = args[1]

    if (verb === "run") {
      const task = this.tasks.find((t) => t.id === id)
      if (!task) { await this.reply(sessionID, `Unknown task: ${id}`); return }
      if (this.locks.has(task.id)) { await this.reply(sessionID, `Task ${id} is already running`); return }
      this.locks.add(task.id)
      void this.runTask(task, sessionID).catch((err) => {
        void this.ctx.storage.set(`task-scheduler:error:${id}`, {
          taskID: id,
          error: String(err),
          stack: (err as Error)?.stack,
          at: Date.now(),
        })
        this.locks.delete(id)
      })
      await this.reply(sessionID, `Started task ${id}`)
    } else if (verb === "debug") {
      try {
        const created = await this.ctx.session.create({
          id: `task-debug-${Date.now()}`,
          title: "⏱ debug session",
          location: { directory: this.ctx.location.directory },
        })
        // List sessions to verify creation
        const sessions = await this.ctx.session.list({ limit: 5 })
        const sessionList = (sessions as any).data ?? []
        await this.ctx.session.synthetic({
          sessionID,
          text: `Debug: created session ${created.id}. Total sessions: ${sessionList.length}. Last: ${sessionList[0]?.title || 'none'}`,
          description: "task-scheduler",
        })
        await this.ctx.session.prompt({
          sessionID: created.id,
          text: "Reply with exactly: DEBUG_OK",
          delivery: "steer",
        })
      } catch (err) {
        await this.reply(sessionID, `Debug failed: ${String(err)}`)
      }
    } else if (verb === "stop") {
      await this.reply(sessionID, "Use /task list to see tasks")
    } else if (verb === "list") {
      const lines = this.tasks.map((t) => `- ${t.id} (${t.start}, session:${t.session})`).join("\n")
      await this.reply(sessionID, `Tasks:\n${lines}`)
    } else {
      await this.reply(sessionID, "Usage: /task run|stop|attach|status|list <id>")
    }
  }

  private async runTask(task: TaskConfig, sessionID: string) {
    await this.log(task.id, "runTask-entered", { sessionID })
    const everyMs = task.loop.every ? parseEvery(task.loop.every) : 0
    let iteration = 0

    while (true) {
      iteration++
      if (task.loop.maxIterations != null && iteration > task.loop.maxIterations) break

      const startedAt = Date.now()
      const deadlineMs = startedAt + task.budget.minutes * 60_000

      const text = iteration === 1 ? task.prompt : (task.continuePrompt ?? `Continue. Iteration ${iteration}.`)
      const minsLeft = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 60_000))
      const fullText = `${text}\n\n[time left: ${minsLeft} min][iteration: ${iteration}]`

      await this.ctx.session.update({ sessionID, title: `⏱ ${task.id} · run ${iteration}` })
      await this.ctx.session.prompt({ sessionID, text: fullText, delivery: "steer" })

      try {
        await this.ctx.session.wait({ sessionID })
      } catch {
        await sleep(2_000)
      }

      const ctx = await this.ctx.session.context({ sessionID })
      const messages = ctx.data ?? []
      const { outcome, cost, tokens } = readLastOutcome(messages)
      const c = costUSD(cost)

      await this.log(task.id, "iteration-complete", { iteration, outcome, costUSD: c, tokens })

      if (outcome === "succeeded" || iteration >= (task.loop.maxIterations || 999)) {
        await this.finishRun(task, sessionID, iteration, "done")
        break
      }

      if (everyMs <= 0) continue
      await sleep(jitter(everyMs, 0.1))
    }

    this.locks.delete(task.id)
  }

  private async finishRun(task: TaskConfig, sessionID: string, iteration: number, outcome: string) {
    await this.store.appendRun(task.id, {
      taskID: task.id,
      runIndex: iteration,
      startedAt: Date.now() - 60_000,
      endedAt: Date.now(),
      outcome: outcome as any,
      costUSD: 0,
      tokens: 0,
    })
    await this.ctx.storage.set(`task-scheduler:last-event:${task.id}`, {
      taskID: task.id,
      runIndex: iteration,
      outcome,
      at: Date.now(),
    })
  }

  private async reply(sessionID: string, text: string) {
    await this.ctx.session.synthetic({ sessionID, text, description: "task-scheduler" }).catch(() => {})
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
