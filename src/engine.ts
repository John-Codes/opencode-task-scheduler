import { Plugin } from "@opencode/plugin"
import { TaskStore } from "./state.js"
import { taskControlTools, type TaskControlState } from "./tools.js"
import { readLastOutcome, costUSD, tokensUsed, formatMinutes } from "./runner.js"
import { parseEvery, jitter, type TaskConfig, type LoopSpec, type Until } from "./schedule.js"

interface RunCtx {
  task: TaskConfig
  store: TaskStore
  sessionID: string
  state: TaskControlState
  abort: AbortController
  iteration: number
  deadlineMs: number
  startedAt: number
}

export class TaskEngine {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private locks = new Set<string>()
  private runs = new Map<string, RunCtx>()

  constructor(
    private ctx: {
      session: {
        create: (input: { id?: string; title?: string; agent?: string; model?: { providerID: string; id: string }; location?: { directory: string }; metadata?: Record<string, unknown>; permissions?: { action: string; resource: string; effect: "allow" | "ask" | "deny" }[] }) => Promise<{ id: string }>
        get: (input: { sessionID: string }) => Promise<any>
        prompt: (input: { sessionID: string; text: string; delivery?: "steer" | "queue" }) => Promise<any>
        wait: (input: { sessionID: string }) => Promise<void>
        interrupt: (input: { sessionID: string; resume?: boolean }) => Promise<{ interrupted: boolean }>
        update: (input: { sessionID: string; title?: string }) => Promise<void>
        remove: (input: { sessionID: string }) => Promise<void>
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
      }
      storage: { get: (k: string) => Promise<any>; set: (k: string, v: any) => Promise<void>; remove: (k: string) => Promise<void> }
    },
    private tasks: TaskConfig[],
  ) {
    this.store = new TaskStore(ctx.storage)
  }

  private store: TaskStore

  async setup() {
    // Register task-control tools the agent can call during loops.
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
      // We reset per-run via runCtx below; this shared placeholder keeps the
      // tool signature stable. Per-run state is injected at run start.
      for (const t of taskControlTools(shared)) editor.add(t)
    })
    await this.ctx.tool.reload()

    // Register /task commands.
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

    // Arm startup tasks immediately (detached, non-blocking).
    for (const task of this.tasks) {
      if (task.start === "startup") this.arm(task)
    }

    return () => this.teardown()
  }

  teardown() {
    for (const [id, t] of this.timers) clearTimeout(t)
    this.timers.clear()
    this.locks.clear()
    for (const [id, run] of this.runs) {
      void this.ctx.session.interrupt({ sessionID: run.sessionID }).catch(() => {})
    }
    this.runs.clear()
  }

  private arm(task: TaskConfig) {
    if (this.locks.has(task.id)) return
    this.locks.add(task.id)
    void this.runLoop(task).catch((err) => {
      console.error(`[task-scheduler] task ${task.id} loop error:`, err)
      this.locks.delete(task.id)
    })
  }
  private async runLoop(task: TaskConfig) {
    const everyMs = task.loop.every ? parseEvery(task.loop.every) : 0
    let iteration = 0

    // initial delay
    if (task.loop.initialDelay) {
      await sleep(parseEvery(task.loop.initialDelay))
    }

    while (true) {
      iteration++
      if (task.loop.maxIterations != null && iteration > task.loop.maxIterations) break

      let run: RunCtx | undefined
      try {
        run = await this.startRun(task, iteration)
        this.runs.set(task.id, run)
        await this.store.setRunning(task.id, true)

        const result = await this.runIteration(run)

        if (result.stop) {
          await this.finishRun(task, run, result.outcome, result.summary)
          break
        }

        // check deadline
        if (run.deadlineMs && Date.now() >= run.deadlineMs) {
          await this.finishRun(task, run, "timed-out", `Deadline reached after ${formatMinutes(Date.now() - run.startedAt)}`)
          break
        }

        // check cost budget
        if (task.budget.maxCostUSD != null && result.costUSD >= task.budget.maxCostUSD) {
          await this.finishRun(task, run, "timed-out", `Cost budget reached ($${task.budget.maxCostUSD})`)
          break
        }
      } catch (err) {
        await this.ctx.storage.set(`task-scheduler:error:${task.id}`, {
          taskID: task.id,
          iteration,
          error: String(err),
          at: Date.now(),
        })
        throw err
      } finally {
        if (run) {
          this.runs.delete(task.id)
          await this.store.setRunning(task.id, false, undefined)
        }
      }

      // sleep between iterations ("every X")
      if (everyMs <= 0) continue
      await sleep(jitter(everyMs, 0.1))
    }

    this.locks.delete(task.id)
    await this.store.setRunning(task.id, false)
  }

  private async startRun(task: TaskConfig, iteration: number): Promise<RunCtx> {
    const abort = new AbortController()
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

    // Re-register tools with per-run state so the executor closes over this run.
    const reg = await this.ctx.tool.transform((editor) => {
      for (const t of taskControlTools(state)) editor.add(t)
    })

    let sessionID: string
    if (task.session === "current") {
      // Use the active session; fall back to creating one.
      sessionID = await this.currentOrCreateSession(task)
    } else {
      const created = await this.ctx.session.create({
        id: `task-${task.id}-${iteration}-${startedAt}`,
        title: `⏱ ${task.id} · run ${iteration}`,
        agent: task.agent,
        model: task.model,
        location: this.ctx.session.create.length ? undefined : undefined,
        permissions: task.budget.autoApprove
          ? [{ action: "*", resource: "*", effect: "allow" }, ...(task.budget.deny ?? []).map((d) => ({ action: "bash", resource: d, effect: "deny" }))]
          : task.permissions,
      })
      sessionID = created.id
    }

    // Pin goal + deadline into instructions so it survives compaction.
    await this.ctx.session.instructions.entry.put({
      sessionID,
      key: "task-scheduler/goal",
      value: `TASK: ${task.prompt}\nSTOP WHEN: the agent calls task_done, or the deadline of ${new Date(deadlineMs).toISOString()} is reached.\nYou may call task_extend(minutes, reason) if you need more time.\nCurrent iteration: ${iteration}`,
    })

    return { task, store: this.store, sessionID, state, abort, iteration, deadlineMs, startedAt }
  }

  private async currentOrCreateSession(task: TaskConfig): Promise<string> {
    try {
      // best effort: find an active session at this location
      // (no list API guaranteed; create a fresh one if unsure)
      const created = await this.ctx.session.create({
        id: `task-${task.id}-${Date.now()}`,
        title: `⏱ ${task.id} · run`,
        agent: task.agent,
        model: task.model,
        permissions: task.budget.autoApprove
          ? [{ action: "*", resource: "*", effect: "allow" }, ...(task.budget.deny ?? []).map((d) => ({ action: "bash", resource: d, effect: "deny" }))]
          : task.permissions,
      })
      return created.id
    } catch {
      throw new Error(`task ${task.id}: session:"current" requires an active session; use session:"new" instead`)
    }
  }

  private async runIteration(run: RunCtx): Promise<{ stop: boolean; outcome?: string; summary?: string; costUSD: number }> {
    const { task, sessionID, state } = run
    const text = run.iteration === 1 ? task.prompt : (task.continuePrompt ?? `Continue. Iteration ${run.iteration}. Call task_done when finished.`)

    // Add time-left hint to the prompt so the model paces itself.
    const minsLeft = run.deadlineMs ? Math.max(0, Math.ceil((run.deadlineMs - Date.now()) / 60_000)) : 0
    const fullText = `${text}\n\n[time left: ${minsLeft} min][iteration: ${run.iteration}]`

    await this.ctx.session.update({ sessionID, title: `⏱ ${task.id} · run ${run.iteration}` })
    await this.ctx.session.prompt({ sessionID, text: fullText, delivery: "steer" })

    // Wait for the agent loop to go idle.
    try {
      await this.ctx.session.wait({ sessionID })
    } catch {
      // wait may not be available on older servers; fall back to a short sleep
      await sleep(2_000)
    }

    // Read outcome from context.
    const ctx = await this.ctx.session.context({ sessionID })
    const messages = ctx.data ?? []
    const { outcome, cost, tokens } = readLastOutcome(messages)
    const c = costUSD(cost)
    const t = tokensUsed(tokens)

    // If agent called task_done, state.done is true.
    if (state.done) {
      return { stop: true, outcome: "done", summary: state.progressNote, costUSD: c }
    }

    // External until-condition check.
    if (task.loop.until && task.loop.until.kind !== "agent" && task.loop.until.kind !== "none") {
      const met = await this.checkUntil(task.loop.until)
      if (met) {
        return { stop: true, outcome: "done", summary: `until-condition met: ${task.loop.until.kind}`, costUSD: c }
      }
    }

    return { stop: false, costUSD: c }
  }

  private async checkUntil(until: Until): Promise<boolean> {
    if (until.kind === "command") {
      const { exec } = await import("child_process")
      const { promisify } = await import("util")
      const execAsync = promisify(exec)
      try {
        await execAsync(until.command, { timeout: 30_000 })
        return true
      } catch {
        return false
      }
    }
    if (until.kind === "file") {
      try {
        const { readFile } = await import("fs/promises")
        const content = await readFile(until.path, "utf8")
        return until.notEmpty ? content.trim().length > 0 : true
      } catch {
        return false
      }
    }
    return false
  }

  private async finishRun(task: TaskConfig, run: RunCtx, outcome: string, summary?: string) {
    await this.ctx.session.instructions.entry.remove({ sessionID: run.sessionID, key: "task-scheduler/goal" }).catch(() => {})
    const c = 0 // cost read during iteration; stored via store
    await this.store.appendRun(task.id, {
      taskID: task.id,
      runIndex: run.iteration,
      startedAt: run.startedAt,
      endedAt: Date.now(),
      outcome: outcome as any,
      costUSD: c,
      tokens: 0,
      summary,
    })

    // Notify via TUI-facing storage so the TUI part can show toasts.
    await this.ctx.storage.set(`task-scheduler:last-event:${task.id}`, {
      taskID: task.id,
      runIndex: run.iteration,
      outcome,
      summary,
      at: Date.now(),
    })
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
      void this.runLoop(task).catch((err) => {
        console.error(`[task-scheduler] manual run ${id} error:`, err)
        this.locks.delete(task.id)
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
    } else if (verb === "attach") {
      const run = this.runs.get(id)
      if (run) {
        await this.reply(sessionID, `Task ${id} is running in session ${run.sessionID}`)
      } else {
        await this.reply(sessionID, `No running task: ${id}`)
      }
    } else if (verb === "status") {
      const task = this.tasks.find((t) => t.id === id)
      const run = this.runs.get(id)
      const state = await this.store.getState(id)
      let line = `Task ${id}: ${state.status}`
      if (run) line += ` · run ${run.iteration} · ${formatMinutes(Math.max(0, run.deadlineMs - Date.now()))} left`
      if (state.lastRun) line += ` · last: ${state.lastRun.outcome}`
      await this.reply(sessionID, line)
    } else if (verb === "list") {
      const lines = this.tasks.map((t) => `- ${t.id} (${t.start}, every ${t.loop.every ?? "manual"})`).join("\n")
      await this.reply(sessionID, `Tasks:\n${lines}`)
    } else {
      await this.reply(sessionID, "Usage: /task run|stop|attach|status|list <id>")
    }
  }

  private async reply(sessionID: string, text: string) {
    await this.ctx.session.synthetic({ sessionID, text, description: "task-scheduler" }).catch(() => {})
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
