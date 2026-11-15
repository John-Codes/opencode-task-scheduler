import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "task-scheduler",
  async setup(ctx) {
    // Minimal: register a /task command that creates a session
    await ctx.command.transform((editor) => {
      editor.add({
        name: "task",
        description: "Test task command",
        execute: async ({ sessionID, prompt }) => {
          const text = prompt?.text ?? ""
          const args = text.trim().split(/\s+/)
          const verb = args[0]

          if (verb === "debug") {
            const created = await ctx.session.create({
              id: `task-debug-${Date.now()}`,
              title: "⏱ debug session",
              location: { directory: ctx.location.directory },
            })
            await ctx.session.prompt({
              sessionID: created.id,
              text: "Reply with exactly: DEBUG_OK",
              delivery: "steer",
            })
            await ctx.session.synthetic({
              sessionID,
              text: `Debug: created session ${created.id}, prompt sent`,
              description: "task-scheduler",
            })
          } else if (verb === "list") {
            await ctx.session.synthetic({
              sessionID,
              text: `Tasks: ai-news (startup, every manual)`,
              description: "task-scheduler",
            })
          } else {
            await ctx.session.synthetic({
              sessionID,
              text: "Usage: /task debug|list",
              description: "task-scheduler",
            })
          }
        },
      })
    })
    await ctx.command.reload()

    // Also try creating a session on setup to verify startup works
    const test = await ctx.session.create({
      id: `task-scheduler-setup-test-${Date.now()}`,
      title: "⏱ setup test session",
      location: { directory: ctx.location.directory },
    })
    await ctx.session.prompt({
      sessionID: test.id,
      text: "Reply with exactly: SETUP_TEST_OK",
      delivery: "steer",
    })
    await ctx.session.synthetic({
      sessionID: test.id,
      text: "Setup test: session created and prompt sent",
      description: "task-scheduler",
    })

    return () => {}
  },
})
