import type { Schema } from "@opencode/plugin"

export type RunOutcome = "done" | "timed-out" | "blocked" | "error" | "stopped"

export interface RunRecord {
  taskID: string
  runIndex: number
  startedAt: number
  endedAt?: number
  outcome?: RunOutcome
  costUSD?: number
  tokens?: number
  summary?: string
}

export interface TaskState {
  enabled: boolean
  lastRun?: RunRecord
  totalRuns: number
  totalCostUSD: number
  nextRunAt?: number
  status: "idle" | "running" | "stopped"
}

export class TaskStore {
  private ctx: { get: (k: string) => Promise<Schema.Json | undefined>; set: (k: string, v: Schema.Json) => Promise<void>; remove: (k: string) => Promise<void> }

  constructor(ctx: { get: (k: string) => Promise<Schema.Json | undefined>; set: (k: string, v: Schema.Json) => Promise<void>; remove: (k: string) => Promise<void> }) {
    this.ctx = ctx
  }

  private key(taskID: string) {
    return `task-scheduler:state:${taskID}`
  }

  private historyKey(taskID: string) {
    return `task-scheduler:history:${taskID}`
  }

  async getState(taskID: string): Promise<TaskState> {
    const raw = await this.ctx.get(this.key(taskID))
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as TaskState
    }
    return { enabled: true, totalRuns: 0, totalCostUSD: 0, status: "idle" }
  }

  async setState(taskID: string, state: TaskState) {
    await this.ctx.set(this.key(taskID), state)
  }

  async getHistory(taskID: string): Promise<RunRecord[]> {
    const raw = await this.ctx.get(this.historyKey(taskID))
    if (Array.isArray(raw)) return raw as RunRecord[]
    return []
  }

  async appendRun(taskID: string, run: RunRecord) {
    const history = await this.getHistory(taskID)
    history.push(run)
    // keep last 200 runs
    if (history.length > 200) history.splice(0, history.length - 200)
    await this.ctx.set(this.historyKey(taskID), history)

    const state = await this.getState(taskID)
    state.totalRuns++
    state.lastRun = run
    state.status = "idle"
    if (run.costUSD != null) state.totalCostUSD += run.costUSD
    await this.setState(taskID, state)
  }

  async setRunning(taskID: string, running: boolean, nextRunAt?: number) {
    const state = await this.getState(taskID)
    state.status = running ? "running" : "idle"
    if (nextRunAt != null) state.nextRunAt = nextRunAt
    await this.setState(taskID, state)
  }
}
