# @e2e-dev/acp

Run `agent.act` and `agent.assert` on a coding agent you already use, over
the [Agent Client Protocol](https://agentclientprotocol.com): Claude Code,
Codex, Cursor, or any agent with an ACP mode. The agent signs in with its own
login, so e2e needs no model provider of its own.

```ts
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { acpExecutor } from '@e2e-dev/acp';

export default {
  targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }],
  agents: {
    default: {
      // Zed's adapter for Claude Code: npm install -D @agentclientprotocol/claude-agent-acp
      executor: acpExecutor({ command: 'npx', args: ['claude-agent-acp'], model: 'sonnet' }),
    },
  },
} satisfies E2EConfig;
```

One agent session serves one test attempt. The agent gets the action verbs
the target's engine supports, `observe`, and `complete_step`, as an MCP
server the test worker serves on 127.0.0.1. Every action goes through the
runner, so steps replay from the cache without the agent. Permission
requests for anything but those tools are rejected.

See the [guide](https://e2e.tester.army/docs/acp) for Codex and Cursor,
options, and limits.
