import { Plugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"

export default Plugin.define({
  id: "task-scheduler",
  setup(context) {
    const { client, data, ui, attention, location } = context

    // Footer status slot: show next run / running task.
    const unsub = ui.slot({
      append: "home.footer.status",
      render: () => {
        // Best-effort: read storage directly isn't available in TUI context;
        // instead show a static hint that the plugin is active.
        return <text>task-scheduler active</text>
      },
    })

    // Palette command: attach to a running task.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "task-scheduler.attach",
          title: "Attach to running task",
          palette: true,
          run: async () => {
            const active = data.session.list().find((s) => s.title?.startsWith("⏱"))
            if (active) {
              ui.tabs.focus(active.sessionID)
              ui.router.navigate({ type: "session", sessionID: active.sessionID })
            } else {
              ui.toast.show({ title: "task-scheduler", message: "No task session running", variant: "info" })
            }
          },
        },
      ],
    }))

    // Listen for task events from the server part via storage polling is not
    // available reactively here; instead we surface a manual status command.
    return () => {
      unsub()
    }
  },
})
