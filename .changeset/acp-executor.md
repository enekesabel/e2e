---
"@e2e-dev/acp": minor
---

New package: `acpExecutor()` runs `agent.act` and `agent.assert` on a coding agent over the Agent Client Protocol (Claude Code, Codex, Cursor, or any agent with an ACP mode), signed in with the agent's own login. One agent session serves a test attempt; the action grammar reaches the agent as an MCP server on 127.0.0.1, every action goes through `ctx.actions`, and permission requests for anything but those tools are rejected.
