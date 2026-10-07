/**
 * Hand-run check of acpExecutor against a real agent, never part of
 * `pnpm test`: it spends the agent's own login. Runs the CLI test's two tests
 * (a todo act plus assert, a secret login) twice in a throwaway project, the
 * first run recording and the second replaying, and prints each step.
 *
 *   pnpm build
 *   node packages/acp/tests/live/acp.ts
 *
 * The agent defaults to Claude Code through Zed's adapter with Sonnet. Override
 * with ACP_COMMAND, ACP_ARGS (a JSON array), ACP_MODEL, and ACP_SESSION_META
 * (JSON), e.g. ACP_COMMAND=agent ACP_ARGS='["acp"]' ACP_MODEL= for Cursor.
 */

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const password = 'acp-live-secret-value';
const command = process.env['ACP_COMMAND'] ?? 'npx';
const args = process.env['ACP_ARGS'] === undefined ? ['-y', '@agentclientprotocol/claude-agent-acp@0.86.0'] : (JSON.parse(process.env['ACP_ARGS']) as string[]);
const model = process.env['ACP_MODEL'] ?? (process.env['ACP_COMMAND'] === undefined ? 'sonnet' : '');
const sessionMeta =
  process.env['ACP_SESSION_META'] === undefined
    ? process.env['ACP_COMMAND'] === undefined
      ? { claudeCode: { options: { tools: [], settingSources: [], strictMcpConfig: true, persistSession: false } } }
      : undefined
    : (JSON.parse(process.env['ACP_SESSION_META']) as Record<string, unknown>);

const app = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  const login = (request.url ?? '').startsWith('/login');
  response.end(
    login
      ? `<!doctype html><html><body><h1>Login</h1><label>Name<input id="name"></label><label>Password<input id="password" type="password"></label><button id="go">Sign in</button><p role="status" id="status"></p><script>document.getElementById("go").onclick = () => { document.getElementById("status").textContent = document.getElementById("password").value === ${JSON.stringify(password)} ? "Hello " + document.getElementById("name").value : "Invalid password"; };</script></body></html>`
      : '<!doctype html><html><body><h1>Todos</h1><label>New todo<input id="name"></label><button id="add">Add</button><ul id="list"></ul><script>document.getElementById("add").onclick = () => { const li = document.createElement("li"); li.textContent = document.getElementById("name").value; document.getElementById("list").appendChild(li); };</script></body></html>',
  );
});
await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

const directory = await mkdtemp(join(tmpdir(), 'e2e-acp-live-'));
await mkdir(join(directory, 'node_modules/@e2e-dev'), { recursive: true });
await symlink(join(root, 'e2e'), join(directory, 'node_modules/e2e'));
await symlink(join(root, 'acp'), join(directory, 'node_modules/@e2e-dev/acp'));
await symlink(join(root, 'web'), join(directory, 'node_modules/@e2e-dev/web'));
await writeFile(
  join(directory, 'e2e.config.ts'),
  [
    'import { web } from "@e2e-dev/web";',
    'import { acpExecutor } from "@e2e-dev/acp";',
    'export default {',
    '  tests: "acp.e2e.ts",',
    '  cache: "read-write",',
    `  targets: [{ engine: web(), app: { url: ${JSON.stringify(appUrl)} } }],`,
    `  credentials: { admin: { username: "Ada", password: ${JSON.stringify(password)} } },`,
    `  agents: { default: { executor: acpExecutor(${JSON.stringify({ command, args, ...(model === '' ? {} : { model }), ...(sessionMeta === undefined ? {} : { sessionMeta }) })}) } },`,
    '};',
  ].join('\n'),
);
await writeFile(
  join(directory, 'acp.e2e.ts'),
  [
    'import { test, expect, credentials } from "e2e";',
    'test("todo flow", async ({ app, screen, agent }) => {',
    '  await app.open("/todos");',
    '  await agent.act("Add a todo named Buy milk.");',
    '  await expect(screen.getByText("Buy milk")).toBeVisible();',
    '  await agent.assert("The list shows Buy milk.");',
    '});',
    'test("secret login", async ({ app, screen, agent }) => {',
    '  await app.open("/login");',
    '  await agent.act("Sign in as Ada.", { params: { password: credentials.user("admin").password } });',
    '  await expect(screen.getByRole("status")).toHaveText("Hello Ada");',
    '});',
  ].join('\n'),
);

interface Step {
  api?: string;
  label?: string;
  status?: string;
  durationMs?: number;
  cache?: { mode?: string };
  metrics?: { modelCalls?: number; actionSteps?: number };
  model?: unknown;
  error?: { code?: string; message?: string };
}
interface Report {
  run: { results: { titlePath: string[]; status: string; attempts: { steps: Step[] }[] }[] };
}

let failed = false;
try {
  for (const phase of ['record', 'replay']) {
    const started = Date.now();
    try {
      await execFileAsync(process.execPath, [join(root, 'e2e/dist/cli/bin.js'), 'run', 'acp.e2e.ts', '--workers', '1'], {
        cwd: directory,
        env: { ...process.env, E2E_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
        timeout: 600_000,
      });
    } catch (error) {
      const { stdout, stderr } = error as { stdout?: string; stderr?: string };
      console.log(`${phase}: e2e run exited non-zero\n${stdout ?? ''}${stderr ?? ''}`);
    }
    const report = JSON.parse(await readFile(join(directory, '.e2e/report.json'), 'utf8')) as Report;
    console.log(`\n## ${phase} (${Math.round((Date.now() - started) / 1000)} s)`);
    for (const result of report.run.results) {
      console.log(`- ${result.titlePath.at(-1)}: ${result.status}`);
      if (result.status !== 'passed') failed = true;
      for (const step of result.attempts.at(-1)?.steps ?? []) {
        if (step.api?.startsWith('agent.') !== true) continue;
        console.log(
          `  ${step.api} "${step.label}": ${step.status}, cache ${step.cache?.mode ?? '-'}, ${step.metrics?.modelCalls ?? 0} model calls, ${step.metrics?.actionSteps ?? 0} actions, ${step.durationMs} ms${step.error === undefined ? '' : `, ${step.error.code}: ${step.error.message}`}`,
        );
        if (step.model !== undefined) console.log(`    model: ${JSON.stringify(step.model)}`);
      }
    }
  }
  const leaked: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if ((await readFile(path, 'utf8')).includes(password)) leaked.push(path);
    }
  };
  await walk(join(directory, '.e2e'));
  console.log(`\nsecret in artifacts: ${leaked.length === 0 ? 'no' : leaked.join(', ')}`);
  if (leaked.length > 0) failed = true;
} finally {
  app.close();
  await rm(directory, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
