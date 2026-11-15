import { Plugin } from "@opencode/plugin"
import { TaskStore } from "./state.js"
import { taskControlTools, type TaskControlState } from "./tools.js"
import { readLastOutcome, costUSD, tokensUsed, formatMinutes } from "./runner.js"
import { parseEvery, jitter, type TaskConfig, type Until } from "./schedule.js"

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
      session: {
        create: (input: { id?: string; title?: string; agent?: string; model?: { providerID: string; id: string }; location?: { directory: string }; metadata?: Record<string, unknown>; permissions?: { action: string; resource: string; effect: "allow" | "ask" | "deny" }[] }) => Promise<{ data: { id: string } }>
        prompt: (input: { sessionID: string; text: string; delivery?: "steer" | "queue" }) => Promise<any>
        wait: (input: { sessionID: string }) => Promise<void>
        interrupt: (input: { sessionID: string; resume?: boolean }) => Promise<{ interrupted: boolean }>
        update: (input: { sessionID: string; title?: string }) => Promise<void>
        context: (input: { sessionID: string }) => Promise<{ data: any[] }>
        instructions: {
          entry: {
            put: (input: { sessionID: string; key: string; value: string }) => Promise<void>
            remove: (input: { sessionID: string; key: string }) => Promise<void>
          }
        }
      }
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
    },
    private tasks: TaskConfig[],
  ) {
    this.store = new TaskStore(ctx.storage)
  }

  private store: TaskStore

  async setup() {
    // Persist tasks for TUI part
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

    // Register /task commands
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
            void this.runTask(task).catch((err) => {
              void this.ctx.storage.set(`task-scheduler:error:${id}`, {
                taskID: id,
                error: String(err),
                stack: (err as Error)?.stack,
                at: Date.now(),
              })
              this.locks.delete(id)
            })
            await this.reply(sessionID, `Started task ${id}`)
          } else if (verb === "stop") {
            const run = this.runs.get(id)
            if (run) {
              await this.ctx.session.interrupt({ sessionID: run.sessionID })
              await this.reply(sessionID, `Stopped task ${id}`)
            } else {
              await this.reply(sessionID, `No running task: ${id}`)
            }
          } else if (verb === "status") {
            const run = this.runs.get(id)
            const state = await this.store.getState(id)
            let line = `Task ${id}: ${state.status}`
            if (run) line += ` · run ${run.iteration} · ${formatMinutes(Math.max(0, run.deadlineMs - Date.now()))} left`
            if (state.lastRun) line += ` · last: ${state.lastRun.outcome}`
            await this.reply(sessionID, line)
          } else if (verb === "list") {
            const lines = this.tasks.map((t) => `- ${t.id} (${t.start})`).join("\n")
            await this.reply(sessionID, `Tasks:\n${lines}`)
          } else {
            await this.reply(sessionID, "Usage: /task run|stop|status|list <id>")
          }
        },
      })
    })
    await this.ctx.command.reload()

    // Arm startup tasks
    for (const task of this.tasks) {
      if (task.start === "startup") this.arm(task)
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

  private async log(taskID: string, event: string, data: any) {
    await this.ctx.storage.set(`task-scheduler:log:${taskID}:${Date.now()}`, {
      taskID, event, data, at: Date.now(),
    })
  }

  private arm(task: TaskConfig) {
    if (this.locks.has(task.id)) return
    this.locks.add(task.id)
    void this.runTask(task).catch((err) => {
      void this.ctx.storage.set(`task-scheduler:error:${task.id}`, {
        taskID: task.id,
        error: String(err),
        stack: (err as Error)?.stack,
        at: Date.now(),
      })
      this.locks.delete(task.id)
    })
  }

  private async reply(sessionID: string, text: string) {
    await this.ctx.session.synthetic({ sessionID, text, description: "task-scheduler" }).catch(() => {})
  }

  private async runTask(task: TaskConfig) {
    await this.log(task.id, "runTask-entered", { session: task.session })
    const everyMs = task.loop.every ? parseEvery(task.loop.every) : 0
    let iteration = 0

    if (task.loop.initialDelay) {
      await sleep(parseEvery(task.loop.initialDelay))
    }

    while (true) {
      iteration++
      if (task.loop.maxIterations != null && iteration > task.loop.maxIterations) break

      const startedAt = Date.now()
      const deadlineMs = startedAt + task.budget.minutes * 60_000

      const state: TaskControlState = {
        done: false,
        extendBy: 0,
        blockReason: null,
        progressNote: null,
        maxExtensions: task.budget.maxExtensions ?? 3,
        extensionsUsed: 0,
        maxTotalMinutes: task.budget.maxTotalMinutes ?? null,
        startedAt,
        deadlineMs,
      }

      // Re-register tools with per-run state
      await this.ctx.tool.transform((editor) => {
        for (const t of taskControlTools(state)) editor.add(t)
      })

      let sessionID: string
      try {
        const created = await this.ctx.session.create({
          id: `task-${task.id}-${iteration}-${startedAt}`,
          title: `⏱ ${task.id} · run ${iteration}`,
          agent: task.agent,
          model: task.model,
          location: { directory: this.ctx.location.directory },
          permissions: task.budget.autoApprove
            ? [{ action: "*", resource: "*", effect: "allow" }, ...(task.budget.deny ?? []).map((d) => ({ action: "bash", resource: d, effect: "deny" }))]
            : task.permissions,
        })
        sessionID = created.data.id
        await this.log(task.id, "session-created", { sessionID, iteration })
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

      // Pin goal into instructions
      try {
        await this.ctx.session.instructions.entry.put({
          sessionID,
          key: "task-scheduler/goal",
          value: `TASK: ${task.prompt}\nSTOP WHEN: the agent calls task_done, or the deadline of ${new Date(deadlineMs).toISOString()} is reached.\nYou may call task_extend(minutes, reason) if you need more time.\nCurrent iteration: ${iteration}`,
        })
      } catch (err) {
        await this.log(task.id, "instructions-put-failed", { error: String(err) })
      }

      const run: RunCtx = { task, sessionID, state, iteration, deadlineMs, startedAt }
      this.runs.set(task.id, run)
      await this.store.setRunning(task.id, true)

      try {
        while (true) {
          const entry = this.runs.get(task.id)
          if (!entry || entry.sessionID !== sessionID) break

          if (Date.now() >= deadlineMs) {
            await this.finishRun(task, run, "timed-out", `Deadline reached after ${formatMinutes(Date.now() - startedAt)}`)
            break
          }

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
          const t = tokensUsed(tokens)

          await this.log(task.id, "iteration-complete", { iteration, outcome, costUSD: c, tokens })

          // Agent called task_done
          if (state.done) {
            await this.finishRun(task, run, "done", state.progressNote)
            break
          }

          // Check cost budget
          if (task.budget.maxCostUSD != null && c >= task.budget.maxCostUSD) {
            await this.finishRun(task, run, "timed-out", `Cost budget reached ($${task.budget.maxCostUSD})`)
            break
          }

          // Check max iterations
          if (iteration >= (task.loop.maxIterations || 999)) {
            await this.finishRun(task, run, "done", `Max iterations reached`)
            break
          }

          // Sleep between iterations ("every X")
          if (everyMs <= 0) continue
          await sleep(jitter(everyMs, 0.1))
          iteration++
        }
      } finally {
        this.runs.delete(task.id)
        await this.store.setRunning(task.id, false)
      }
    }

    this.locks.delete(task.id)
    await this.log(task.id, "runTask-completed", { finalIteration: iteration })
  }

  private async finishRun(task: TaskConfig, run: RunCtx, outcome: string, summary?: string) {
    await this.ctx.session.instructions.entry.remove({ sessionID: run.sessionID, key: "task-scheduler/goal" }).catch(() => {})
    await this.store.appendRun(task.id, {
      taskID: task.id,
      runIndex: run.iteration,
      startedAt: run.startedAt,
      endedAt: Date.now(),
      outcome: outcome as any,
      costUSD: 0,
      tokens: 0,
      summary,
    })
    await this.ctx.storage.set(`task-scheduler:last-event:${task.id}`, {
      taskID: task.id,
      runIndex: run.iteration,
      outcome,
      summary,
      at: Date.now(),
    })
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
