import type { Session } from "@opencode/plugin"

// Reads the last message from a session context to determine outcome and spend.
export function readLastOutcome(messages: Session.Message.Info[]) {
  // Walk backwards for the terminal assistant / idle message.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.type === "idle") {
      return { outcome: m.outcome as "succeeded" | "failed" | "interrupted", cost: m.cost, tokens: m.tokens }
    }
    if (m.type === "assistant") {
      return { outcome: "succeeded", cost: m.cost, tokens: m.tokens }
    }
  }
  return { outcome: undefined as "succeeded" | "failed" | "interrupted" | undefined, cost: undefined, tokens: undefined }
}

export function costUSD(cost?: { amount?: number; currency?: string }) {
  if (!cost?.amount) return 0
  return cost.amount // money.USD amount is already in dollars
}

export function tokensUsed(tokens?: { input?: number; output?: number; total?: number }) {
  return tokens?.total ?? 0
}

export function formatMinutes(ms: number) {
  const m = Math.max(0, Math.round(ms / 60_000))
  return `${m} min`
}
