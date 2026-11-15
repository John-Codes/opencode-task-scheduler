import type { Tool } from "@opencode/plugin"

// Plugin-registered tools the agent can call during a task loop.
// Each executor closes over mutable plugin state captured at registration time.

export interface TaskControlState {
  done: boolean
  extendBy: number
  blockReason: string | null
  progressNote: string | null
  maxExtensions: number
  extensionsUsed: number
  maxTotalMinutes: number | null
  startedAt: number
  deadlineMs: number | null
}

export function taskDoneTool(state: TaskControlState) {
  return {
    name: "task_done",
    description: "Signal that the current task is complete and the loop should stop.",
    input: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Brief summary of what was accomplished" },
      },
      required: ["summary"],
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: async ({ summary }: { summary: string }, context) => {
      state.done = true
      state.progressNote = summary
      return {
        content: `Task marked complete: ${summary}. The scheduler loop will stop after this turn.`,
      }
    },
  }
}

export function taskExtendTool(state: TaskControlState) {
  return {
    name: "task_extend",
    description: "Push the task deadline forward by N minutes. Capped by maxTotalMinutes and maxExtensions.",
    input: {
      type: "object",
      properties: {
        minutes: { type: "number", description: "Minutes to add", minimum: 1 },
        reason: { type: "string", description: "Why more time is needed" },
      },
      required: ["minutes", "reason"],
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: async ({ minutes, reason }: { minutes: number; reason: string }, context) => {
      if (state.maxExtensions != null && state.extensionsUsed >= state.maxExtensions) {
        return { content: `Extension limit reached (${state.maxExtensions}). Cannot extend.` }
      }
      if (state.maxTotalMinutes != null && state.deadlineMs != null && state.startedAt != null) {
        const hardStop = state.startedAt + state.maxTotalMinutes * 60_000
        const proposed = state.deadlineMs + minutes * 60_000
        if (proposed > hardStop) {
          return { content: `Would exceed max total budget (${state.maxTotalMinutes} min). Not extended.` }
        }
        state.deadlineMs = proposed
      } else if (state.deadlineMs != null) {
        state.deadlineMs += minutes * 60_000
      }
      state.extensionsUsed = (state.extensionsUsed ?? 0) + 1
      return {
        content: `Deadline extended by ${minutes} min (reason: ${reason}). Extensions used: ${state.extensionsUsed}.`,
      }
    },
  }
}

export function taskBlockedTool(state: TaskControlState) {
  return {
    name: "task_blocked",
    description: "Report that the task is blocked and cannot continue without user intervention.",
    input: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why the task is blocked" },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: async ({ reason }: { reason: string }, context) => {
      state.blockReason = reason
      return { content: `Task blocked: ${reason}. Awaiting user intervention.` }
    },
  }
}

export function taskProgressTool(state: TaskControlState) {
  return {
    name: "task_progress",
    description: "Log a progress heartbeat for the current task iteration.",
    input: {
      type: "object",
      properties: {
        note: { type: "string", description: "What the agent is working on right now" },
      },
      required: ["note"],
      additionalProperties: false,
    },
    options: { codemode: false },
    execute: async ({ note }: { note: string }, context) => {
      state.progressNote = note
      return { content: `Progress recorded: ${note}` }
    },
  }
}

export const taskControlTools = (
  state: TaskControlState,
): Tool.Info[] => [
  taskDoneTool(state),
  taskExtendTool(state),
  taskBlockedTool(state),
  taskProgressTool(state),
]
