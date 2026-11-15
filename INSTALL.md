# Install opencode-task-scheduler

## As a local plugin (recommended)

```sh
# Clone or copy this repo into your OpenCode plugins directory
mkdir -p ~/.config/opencode/plugins
cp -r /path/to/opencode-task-scheduler ~/.config/opencode/plugins/task-scheduler
```

Add to `~/.config/opencode/opencode.jsonc`:

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

Restart OpenCode:

```sh
opencode service restart
```

## As a published npm package

```sh
npm publish
# then in opencode.jsonc:
# { "package": "opencode-task-scheduler@1.0.0", "options": { ... } }
```

## Verify

- OpenCode starts → a `⏱ triage · run 1` tab opens.
- Watch the agent work in the tab.
- Footer shows `triage · run 1/∞ · 20m left`.
- Agent calls `task_done` → loop stops, toast fires.
- `/task stop triage` → interrupts and hands the session back.
