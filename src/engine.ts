import { Plugin } from "@opencode/plugin"
import { TaskStore } from "./state.js"
import { taskControlTools, type TaskControlState } from "./tools.js"
import { readLastOutcome, costUSD, tokensUsed, formatMinutes } from "./runner.js"
import { parseEvery, jitter, type TaskConfig } from "./schedule.js"

interface RunCtx {
  task: TaskConfig
  sessionID: string
  state: TaskControlState
  iteration: number
  deadlineMs: number
  startedAt: number
}

export class TaskEngine {
  private locks = new Set<string>()
  private runs = new Map<string, RunCtx>()

  constructor(
    private ctx: {
      tool: {
        transform: (cb: (editor: { add: (t: any) => void; remove: (id: string) => void }) => void) => Promise<{ dispose: () => Promise<void> }>
        reload: () => Promise<void>
      }
      command: {
        transform: (cb: (editor: { add: (d: { name: string; description?: string; execute: (i: any) => Promise<void> }) => void }) => void) => Promise<{ dispose: () => Promise<void> }>
        reload: () => Promise<void>
      }
      storage: { get: (k: string) => Promise<any>; set: (k: string, v: any) => Promise<void>; remove: (k: string) => Promise<void> }
      location: { directory: string }
      session: {
        interrupt: (input: { sessionID: string }) => Promise<{ interrupted: boolean }>
      }
    },
    private tasks: TaskConfig[],
  ) {
    this.store = new TaskStore(ctx.storage)
  }

  private store: TaskStore

  async setup() {
    await this.ctx.storage.set("task-scheduler:config", {
      tasks: this.tasks,
      at: Date.now(),
    })

    // Register task-control tools
    await this.ctx.tool.transform((editor) => {
      const shared: TaskControlState = {
        done: false,
        extendBy: 0,
        blockReason: null,
        progressNote: null,
        maxExtensions: 0,
        extensionsUsed: 0,
        maxTotalMinutes: null,
        startedAt: 0,
        deadlineMs: null,
      }
      for (const t of taskControlTools(shared)) editor.add(t)
    })
    await this.ctx.tool.reload()

    // Register /task commands - writes intent to storage for TUI part to pick up
    await this.ctx.command.transform((editor) => {
      editor.add({
        name: "task",
        description: "Manage scheduled agentic tasks",
        execute: async ({ sessionID, prompt }) => {
          const args = (prompt as any)?.text ? String((prompt as any).text) : ""
          const parts = args.trim().split(/\s+/)
          const verb = parts[0]
          const id = parts[1]

          if (verb === "run") {
            const task = this.tasks.find((t) => t.id === id)
            if (!task) { await this.reply(sessionID, `Unknown task: ${id}`); return }
            if (this.locks.has(task.id)) { await this.reply(sessionID, `Task ${id} is already running`); return }
            this.locks.add(task.id)
            await this.ctx.storage.set(`task-scheduler:run-intent:${id}`, {
              taskID: id,
              sessionID,
              at: Date.now(),
            })
            await this.reply(sessionID, `Task ${id} run requested`)
          } else if (verb === "stop") {
            await this.ctx.storage.set(`task-scheduler:stop-intent:${id}`, {
              taskID: id,
              at: Date.now(),
            })
            await this.reply(sessionID, `Task ${id} stop requested`)
          } else if (verb === "list") {
            const lines = this.tasks.map((t) => `- ${t.id} (${t.start})`).join("\n")
            await this.reply(sessionID, `Tasks:\n${lines}`)
          } else {
            await this.reply(sessionID, "Usage: /task run|stop|list <id>")
          }
        },
      })
    })
    await this.ctx.command.reload()

    // Arm startup tasks by writing intents to storage (TUI part will pick them up)
    for (const task of this.tasks) {
      if (task.start === "startup") {
        await this.ctx.storage.set(`task-scheduler:run-intent:${task.id}`, {
          taskID: task.id,
          sessionID: null,
          at: Date.now(),
        })
      }
    }

    return () => this.teardown()
  }

  teardown() {
    this.locks.clear()
    for (const [id, run] of this.runs) {
      void this.ctx.session.interrupt({ sessionID: run.sessionID }).catch(() => {})
    }
    this.runs.clear()
  }

  private async reply(sessionID: string, text: string) {
    await this.ctx.session.synthetic({ sessionID, text, description: "task-scheduler" }).catch(() => {})
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
