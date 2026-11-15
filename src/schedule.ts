export type LoopKind = "while" | "for" | "interval" | "for-each"

export interface UntilAgent { kind: "agent" }
export interface UntilCommand { kind: "command"; command: string }
export interface UntilFile { kind: "file"; path: string; notEmpty?: boolean }
export type Until = UntilAgent | UntilCommand | UntilFile | { kind: "none" }

export interface LoopSpec {
  kind: LoopKind
  every?: string            // human duration, e.g. "15m", "1h", "30s"
  until?: Until
  maxIterations?: number
  items?: { file: string; lines?: boolean }   // for for-each
  initialDelay?: string
  catchUp?: boolean         // run missed iterations on boot (default false)
}

export interface TaskConfig {
  id: string
  start: "startup" | "manual" | "on-demand"
  session: "current" | "new"
  focus: "on-start" | "always" | "never"
  prompt: string
  continuePrompt?: string
  agent?: string
  model?: { providerID: string; id: string }
  loop: LoopSpec
  budget: {
    minutes: number
    maxTotalMinutes?: number
    maxExtensions?: number
    maxCostUSD?: number
    maxSteps?: number
    onTimeout: "interrupt" | "let-finish"
    autoApprove?: boolean
    deny?: string[]
  }
  permissions?: { action: string; resource: string; effect: "allow" | "ask" | "deny" }[]
}

export function parseEvery(spec: string): number {
  const m = spec.trim().match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/i)
  if (!m) throw new Error(`Invalid interval: ${spec}`)
  const n = Number(m[1])
  const unit = (m[2] ?? "m").toLowerCase()
  const mult: Record<string, number> = { s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000, m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000, d: 86_400_000, day: 86_400_000, days: 86_400_000 }
  return n * mult[unit]
}

export function jitter(ms: number, jitterFrac = 0.1) {
  return ms + Math.floor(Math.random() * ms * jitterFrac)
}
