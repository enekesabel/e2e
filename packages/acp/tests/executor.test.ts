import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError, type ExecutorActions, type ExecutorModelCall, type StepExecutorContext } from 'e2e';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acpExecutor } from '../src/index.ts';
import type { AcpExecutorOptions } from '../src/types.ts';

const AGENT = fileURLToPath(new URL('./fixtures/scripted-agent.ts', import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A scripted agent: one list of moves per prompt turn, and the log it writes. */
function scripted(turns: unknown[][], extra: Partial<AcpExecutorOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'e2e-acp-test-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const logFile = join(directory, 'agent.jsonl');
  const executor = acpExecutor({
    command: process.execPath,
    args: [AGENT],
    ...extra,
    env: { ACP_SCRIPT: JSON.stringify(turns), ACP_LOG: logFile, ...extra.env },
  });
  const log = (): Record<string, unknown>[] => {
    try {
      return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  };
  return { executor, log };
}

/** A step context with recorded actions and an attempt the test ends. */
function context(options: { kind?: 'act' | 'assert'; attempt?: ReturnType<typeof attemptOf>; verbs?: (keyof ExecutorActions)[] } = {}) {
  const attempt = options.attempt ?? attemptOf();
  const signal = new AbortController().signal;
  const tap = vi.fn<ExecutorActions['tap']>().mockResolvedValue(undefined);
  const type = vi.fn<ExecutorActions['type']>().mockResolvedValue(undefined);
  const usage: ExecutorModelCall[] = [];
  const transcripts: string[] = [];
  const ctx = {
    step: { kind: options.kind ?? 'act', index: 0, instruction: 'add a todo', params: { title: 'Buy milk' }, secrets: [] },
    attempt: attempt.attempt,
    signal,
    target: { name: 'web', platform: 'web', verbs: new Set(options.verbs ?? ['tap', 'type', 'navigate']) },
    model: undefined,
    providerOptions: undefined,
    ledger: '',
    agentContext: undefined,
    actions: { tap, type } as unknown as ExecutorActions,
    observe: vi.fn<StepExecutorContext['observe']>().mockResolvedValue({
      revision: '1',
      text: '#n1 textbox "Title"\n#n2 button "Add"',
      truncated: false,
      viewport: { width: 800, height: 600 },
      path: '/todos',
    }),
    pixelsTainted: false,
    attachTranscript: (text: string) => void transcripts.push(text),
    attachTurns: () => undefined,
    attachScreenshot: async () => 'screenshot',
    budgets: {
      maxActions: 25,
      maxModelCalls: 25,
      remainingMs: () => 60_000,
      actionsUsed: () => 0,
      recordModelCall: (call?: ExecutorModelCall) => void usage.push(call ?? {}),
      runTool: <T>(_call: unknown, body: () => Promise<T>) => body(),
    },
  } as unknown as StepExecutorContext;
  return { ctx, tap, type, usage, transcripts, end: attempt.end };
}

function attemptOf() {
  const controller = new AbortController();
  const attempt = { testId: 't', attemptId: 'a', index: 0, signal: controller.signal, memory: new Map<string, unknown>() };
  return { attempt, end: () => controller.abort() };
}

const pass = { call: 'complete_step', args: { status: 'passed', summary: 'added' } };

describe('acpExecutor', () => {
  it('rejects a config without a command', () => {
    expect(() => acpExecutor({} as AcpExecutorOptions)).toThrow(/takes \{ command, args \}/);
  });

  it('acts through ctx.actions and passes on complete_step', async () => {
    const { executor, log } = scripted([[{ call: 'type', args: { id: 'n1', value: 'Buy milk' } }, { call: 'tap', args: { id: '#n2' } }, pass]], { model: 'slow' });
    const step = context();
    cleanups.push(step.end);
    const verdict = await executor.runStep(step.ctx);
    expect(verdict).toEqual({ status: 'passed', summary: 'added' });
    expect(step.type).toHaveBeenCalledWith({ id: 'n1' }, 'Buy milk');
    expect(step.tap).toHaveBeenCalledWith({ id: 'n2' });
    expect(step.usage).toEqual([
      expect.objectContaining({ provider: 'scripted-agent', modelId: 'slow', inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, estimatedCostUsd: 0.01 }),
    ]);
    const entries = log();
    expect(entries).toContainEqual({ config: { model: 'slow' } });
    const session = entries.find((entry) => 'session' in entry)?.['session'] as { server: string; tools: string[] };
    expect(session.server).toBe('e2e_step');
    // Only the target's verbs, plus observe and complete_step.
    expect(session.tools.toSorted()).toEqual(['complete_step', 'navigate', 'observe', 'tap', 'type']);
    const tapResult = JSON.stringify(entries.find((entry) => entry['call'] === 'tap'));
    expect(tapResult).toContain('tap done');
    expect(tapResult).toContain('button \\"Add\\"');
  });

  it('keeps one session per attempt and sends the rules only once', async () => {
    const { executor, log } = scripted([[pass], [pass]]);
    const first = context();
    const second = context({ attempt: { attempt: first.ctx.attempt as never, end: first.end } });
    await executor.runStep(first.ctx);
    await executor.runStep(second.ctx);
    const prompts = log().filter((entry) => 'prompt' in entry).map((entry) => String(entry['prompt']));
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('end-to-end testing agent');
    expect(prompts[0]).toContain('Step: add a todo');
    expect(prompts[0]).toContain('Parameters: {"title":"Buy milk"}');
    expect(prompts[1]).not.toContain('end-to-end testing agent');
    expect(log().filter((entry) => 'session' in entry)).toHaveLength(1);
    first.end();
    await vi.waitFor(() => expect(log()).toContainEqual({ closed: true }));
  });

  it('refuses actions on an assertion and fails it with ASSERTION_FAILED', async () => {
    const { executor, log } = scripted([[{ call: 'tap', args: { id: 'n2' } }, { call: 'complete_step', args: { status: 'failed', summary: 'no todo' } }]]);
    const step = context({ kind: 'assert' });
    cleanups.push(step.end);
    const verdict = await executor.runStep(step.ctx);
    expect(verdict).toEqual({ status: 'failed', summary: 'no todo', errorCode: 'ASSERTION_FAILED' });
    expect(step.tap).not.toHaveBeenCalled();
    expect(JSON.stringify(log().find((entry) => entry['call'] === 'tap'))).toContain('this step is an assertion');
  });

  it("rejects the agent's own tools", async () => {
    const { executor, log } = scripted([[{ own: 'Bash: ls ~', kind: 'execute' }, pass]]);
    const step = context();
    cleanups.push(step.end);
    await executor.runStep(step.ctx);
    expect(log()).toContainEqual({ permission: 'Bash: ls ~', outcome: { outcome: 'selected', optionId: 'no' } });
    expect(step.transcripts.join('\n')).toContain('not ours (rejected when asked): Bash: ls ~');
  });

  it('fails with STEP_NO_CONCLUSION when the turn ends without complete_step', async () => {
    const { executor } = scripted([[{ say: 'I could not find the button.' }]]);
    const step = context();
    cleanups.push(step.end);
    const verdict = await executor.runStep(step.ctx);
    expect(verdict.status).toBe('failed');
    expect(verdict.errorCode).toBe('STEP_NO_CONCLUSION');
    expect(verdict.summary).toContain('I could not find the button.');
  });

  it('rethrows a runtime error a tool hit, after cancelling the turn', async () => {
    const { executor, log } = scripted([[{ call: 'tap', args: { id: 'n2' } }, { hang: true }]]);
    const step = context();
    cleanups.push(step.end);
    step.tap.mockRejectedValue(new AgentError('STEP_BUDGET_EXHAUSTED', 'the step used its 25 actions'));
    await expect(executor.runStep(step.ctx)).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
    expect(log()).toContainEqual({ cancelled: true });
  });

  it('reports a model the agent does not offer', async () => {
    const { executor } = scripted([[pass]], { model: 'huge' });
    const step = context();
    cleanups.push(step.end);
    await expect(executor.runStep(step.ctx)).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_FAILED',
      message: expect.stringContaining('does not offer model huge; it offers fast, slow'),
    });
  });

  it('launches the agent from the project directory and opens the session in an empty one', async () => {
    // A relative command resolves against the project, as `npx` finds a locally installed adapter.
    const { executor, log } = scripted([[pass]], { args: [relative(process.cwd(), AGENT)] });
    const step = context();
    cleanups.push(step.end);
    await expect(executor.runStep(step.ctx)).resolves.toMatchObject({ status: 'passed' });
    const session = log().find((entry) => 'session' in entry)?.['session'] as { cwd: string };
    expect(session.cwd.startsWith(join(tmpdir(), 'e2e-acp-'))).toBe(true);
  });

  it('gives each executor its own session in the same attempt', async () => {
    const first = scripted([[pass]], { model: 'fast' });
    const second = scripted([[pass]], { model: 'slow' });
    const step = context();
    cleanups.push(step.end);
    await first.executor.runStep(step.ctx);
    await second.executor.runStep(step.ctx);
    expect(first.log().filter((entry) => 'session' in entry)).toHaveLength(1);
    expect(second.log().filter((entry) => 'session' in entry)).toHaveLength(1);
    expect(second.log()).toContainEqual({ config: { model: 'slow' } });
  });

  it('stops an agent that hangs at startup when the attempt ends', async () => {
    const { executor, log } = scripted([[pass]], { env: { ACP_HANG_INIT: '1' } });
    const step = context();
    cleanups.push(step.end);
    const run = executor.runStep(step.ctx);
    const pid = await vi.waitFor(() => {
      const entry = log().find((line) => 'pid' in line);
      if (entry === undefined) throw new Error('the agent has not started');
      return entry['pid'] as number;
    });
    step.end();
    await expect(run).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED', message: expect.stringContaining('attempt ended') });
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it('reports an agent that does not start', async () => {
    const executor = acpExecutor({ command: join(tmpdir(), 'no-such-acp-agent') });
    const step = context();
    cleanups.push(step.end);
    await expect(executor.runStep(step.ctx)).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED' });
  });
});
