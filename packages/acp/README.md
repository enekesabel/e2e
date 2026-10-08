# @e2e-dev/acp

Run `agent.act` and `agent.assert` on a coding agent you already use, over
the [Agent Client Protocol](https://agentclientprotocol.com): Claude Code,
Codex, Cursor, or any agent with an ACP mode. The agent signs in with its own
login, so e2e needs no model provider of its own.

```bash
npm install -D @e2e-dev/acp @agentclientprotocol/claude-agent-acp
```

```ts
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { acpExecutor } from '@e2e-dev/acp';

export default {
  targets: [{ engine: web(), app: { url: 'http://localhost:3000' } }],
  agents: {
    default: { executor: acpExecutor.claudeCode({ model: 'sonnet' }) },
  },
} satisfies E2EConfig;
```

`acpExecutor.codex()` and `acpExecutor.cursor()` start Codex and Cursor;
`acpExecutor({ command, args })` starts any other ACP agent.

One agent session serves one test attempt. The agent gets the built-in
agent's action tools for the verbs the target's engine supports, and
`complete_step`, and each preset turns off the agent's own tools. Every
action goes through the runner, so steps replay from the cache without the
agent.

See the [guide](https://e2e.tester.army/docs/acp) for options and limits.
