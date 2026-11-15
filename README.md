# opencode-task-scheduler

OpenCode V2 plugin that runs agentic tasks on a loop — starts at OpenCode startup (or manually), then runs `every X` like a `while`/`for` loop until the agent calls `task_done` or the time budget runs out.

Every run happens in a **real OpenCode session tab** you can watch — no hidden subagents, no background-only execution.

## Quick start

Install as a local plugin:

```sh
mkdir -p ~/.config/opencode/plugins/task-scheduler
# copy this repo into ~/.config/opencode/plugins/task-scheduler
```

Add to your `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "~/.config/opencode/plugins/task-scheduler",
      "options": {
        "tasks": [
          {
            "id": "triage",
            "start": "startup",
            "session": "new",
            "focus": "on-start",
            "prompt": "Check CI failures and fix what you can.",
            "continuePrompt": "Keep going. Call task_done when the build is green.",
            "loop": { "kind": "while", "until": "agent", "every": "15m", "maxIterations": 40 },
            "budget": { "minutes": 20, "maxTotalMinutes": 60, "maxExtensions": 3 }
          }
        ]
      }
    }
  ]
}
```

Then restart OpenCode (`opencode service restart`).

## How it works

One unified loop covers every schedule you described:

```
arm at startup (or manually)
for (let n = 0; ; n++) {
  prompt → wait → read outcome
  if agent called task_done           → stop, outcome: "done"
  if past deadline                    → stop, outcome: "timed-out"
  if maxIterations / maxCost hit      → stop
  sleep(loop.every)                   // "every X" lives here
}
```

| Config | Meaning |
|---|---|
| `loop.kind: "while"`, `until: "agent"` | Runs forever until the agent calls `task_done` |
| `loop.kind: "while"`, `until: { command: "..." }` | Stops when a shell command exits 0 |
| `loop.kind: "for"`, `iterations: N` | Fixed-count `for` loop |
| `loop.kind: "interval"`, `every: "15m"` | `while(true)` + sleep — runs until stopped |
| `loop.every: "0"` | Run back-to-back (continuous agentic) |

Both guards are always active, and the agent can **extend the deadline** with `task_extend(minutes)` — so it can finish early or ask for more time when a task needs it.

## Commands

All commands run in OpenCode's command palette and slash-completion:

| Command | What it does |
|---|---|
| `/task run <id>` | Run a task now (defaults to the current session tab) |
| `/task stop <id>` | Interrupt a running task and hand the session back |
| `/task attach <id>` | Jump to a running task's session tab |
| `/task status <id>` | Show deadline, iteration, spend, last outcome |
| `/task list` | List all configured tasks and their state |

## Visibility

- Startup-armed tasks open their own session tab (`focus: "on-start"`) so you see exactly what the agent is doing.
- The footer shows `triage · run 4/∞ · 12m left · next in 40s`.
- Toasts and attention notifications fire on `done`, `timed-out`, or `blocked`.
- You can type into the session mid-run; the loop waits for idle after its own prompt and resumes after your turn.

## Safety

Unattended runs inherit your normal permission rules by default — a permission prompt will stall the run and the plugin reports "blocked". Opt in to auto-approve per task with `budget.autoApprove: true`, and use `budget.deny` to keep dangerous commands off-limits even then.

## License

MIT
