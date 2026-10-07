import { randomUUID } from 'node:crypto';
import { AgentError, type JsonValue, type StepExecutor, type StepExecutorContext, type StepVerdict } from 'e2e';
import { ConfigurationError } from 'e2e/engine';
import { startSession, type AcpSession, type TurnReport } from './session.ts';
import { screen, stepTools, type ActiveStep, type StepSlot } from './tools.ts';
import type { AcpExecutorOptions } from './types.ts';

const RULES = `You are an end-to-end testing agent driving a real application for a test.
Each message from the test is one step: an action to perform, or an assertion to judge, with the current screen.
The screen is a tree of nodes, one per line, each with an id like "n42" that the action tools take. Never invent ids.
Use only the tools of this conversation. You have no access to the application's source, files, shell, or network.
Work only toward the given step; do not start the next one. Every action tool returns the screen after it, so you do not need to observe after an action.
For an assertion, judge the condition from the screen without acting.
End every step with complete_step: "passed" only when the screen shows the outcome the step asked for (or the condition holds), else "failed" with the reason.`;

interface Held {
  readonly session: Promise<AcpSession>;
  readonly slot: StepSlot;
  introduced: boolean;
}

/**
 * Builds a step executor that runs `agent.act` and `agent.assert` on an
 * ACP agent: one agent session per test attempt, started by its first agent
 * step and closed when the attempt ends.
 */
export function acpExecutor(options: AcpExecutorOptions): StepExecutor {
  if (typeof options !== 'object' || options === null || typeof options.command !== 'string' || options.command === '') {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      "acpExecutor() takes { command, args }, e.g. acpExecutor({ command: 'npx', args: ['@agentclientprotocol/claude-agent-acp'] })",
    );
  }
  // Where an attempt's session lives in `attempt.memory`: one key per executor, so two ACP agents never share a session.
  const memoryKey = `@e2e-dev/acp.session.${randomUUID()}`;
  return {
    name: options.name ?? 'acp',
    version: '1',
    cache: 'inherit',
    async runStep(ctx) {
      const held = hold(ctx, options, memoryKey);
      let session: AcpSession;
      try {
        session = await held.session;
      } catch (error) {
        ctx.attempt.memory.delete(memoryKey);
        throw new AgentError('MODEL_PROVIDER_FAILED', `The ACP agent did not start: ${message(error)}`, { cause: error });
      }
      const text = await stepMessage(ctx, held.introduced ? undefined : [RULES, options.system, ctx.agentContext]);
      held.introduced = true;
      const active: ActiveStep = { ctx, verdict: undefined, halted: undefined, calls: [] };
      held.slot.active = active;
      const cancel = () => session.cancel();
      ctx.signal.addEventListener('abort', cancel, { once: true });
      let report: TurnReport;
      try {
        report = await session.prompt(text);
      } catch (error) {
        ctx.signal.throwIfAborted();
        session.close();
        ctx.attempt.memory.delete(memoryKey);
        throw new AgentError('MODEL_PROVIDER_FAILED', `The ACP agent session failed: ${message(error)}`, { cause: error });
      } finally {
        held.slot.active = undefined;
        ctx.signal.removeEventListener('abort', cancel);
      }
      ctx.attachTranscript(transcript(text, active, report));
      if (active.halted !== undefined) throw active.halted;
      ctx.signal.throwIfAborted();
      const usage = report.usage;
      ctx.budgets.recordModelCall({
        startedAt: report.startedAt,
        durationMs: report.durationMs,
        ...(session.agentName === undefined ? {} : { provider: session.agentName }),
        ...(session.modelId === undefined ? {} : { modelId: session.modelId }),
        ...(usage === undefined
          ? {}
          : {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              ...(usage.cachedReadTokens == null ? {} : { cacheReadTokens: usage.cachedReadTokens }),
              ...(usage.cachedWriteTokens == null ? {} : { cacheWriteTokens: usage.cachedWriteTokens }),
            }),
        ...(report.costUsd === undefined ? {} : { estimatedCostUsd: report.costUsd }),
      });
      return active.verdict ?? noConclusion(report);
    },
  };
}

/** The attempt's session, started on its first step and closed when the attempt ends. */
function hold(ctx: StepExecutorContext, options: AcpExecutorOptions, memoryKey: string): Held {
  const existing = ctx.attempt.memory.get(memoryKey) as Held | undefined;
  if (existing !== undefined) return existing;
  let session: AcpSession | undefined;
  let closed = false;
  const slot: StepSlot = { active: undefined, halt: () => session?.cancel() };
  const held: Held = {
    slot,
    introduced: false,
    session: startSession(options, stepTools(slot, ctx.target.verbs), ctx.attempt.signal).then((started) => {
      session = started;
      if (closed) started.close();
      return started;
    }),
  };
  held.session.catch(() => undefined);
  ctx.attempt.memory.set(memoryKey, held);
  ctx.attempt.signal.addEventListener(
    'abort',
    () => {
      closed = true;
      session?.close();
    },
    { once: true },
  );
  return held;
}

/** The message for one step: the rules on the first, then the step, what already ran, and the screen. */
async function stepMessage(ctx: StepExecutorContext, introduction: (string | undefined)[] | undefined): Promise<string> {
  const parts: string[] = [];
  if (introduction !== undefined) parts.push(...introduction.filter((part): part is string => part !== undefined && part.trim() !== ''));
  const { step } = ctx;
  parts.push(`${step.kind === 'assert' ? 'Assertion' : 'Step'}: ${step.instruction}`);
  const params = plainParams(step.params);
  if (params !== undefined) parts.push(`Parameters: ${JSON.stringify(params)}`);
  if (step.secrets.length > 0) {
    parts.push(`Secrets to fill with type_secret, by name: ${step.secrets.map((secret) => `${secret.name} (${secret.purpose})`).join(', ')}`);
  }
  if (ctx.ledger !== '') parts.push(`Steps completed so far in this test, including any replayed without you:\n${ctx.ledger}`);
  const prefix = ctx.replayedPrefix;
  if (prefix !== undefined) {
    parts.push(
      `A cached replay already performed these actions for this step: ${prefix.replayedActions.join('; ')}. It stopped (${prefix.stopReason}). Continue from the current screen; do not redo them.`,
    );
    if (prefix.uncertainAction !== undefined) {
      parts.push(`This replayed action may have taken effect although it failed: ${prefix.uncertainAction}. Check the screen before doing anything like it again.`);
    }
  }
  parts.push(await screen(ctx));
  return parts.join('\n\n');
}

/** The params without secret placeholders, which are listed by name instead. */
function plainParams(params: Readonly<Record<string, JsonValue>> | undefined): Record<string, JsonValue> | undefined {
  if (params === undefined) return undefined;
  const plain = Object.fromEntries(
    Object.entries(params).filter(([, value]) => !isSecretPlaceholder(value)),
  );
  return Object.keys(plain).length === 0 ? undefined : plain;
}

/** A secret in the params, as the runner projects it: `{ kind: 'secret', name, purpose }`. */
function isSecretPlaceholder(value: JsonValue): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as Record<string, JsonValue>)['kind'] === 'secret';
}

function noConclusion(report: TurnReport): StepVerdict {
  const said = report.text.trim().split('\n').at(-1)?.slice(0, 300);
  return {
    status: 'failed',
    errorCode: 'STEP_NO_CONCLUSION',
    summary: `The agent ended its turn (${report.stopReason}) without complete_step${said === undefined || said === '' ? '' : `: ${said}`}`,
  };
}

function transcript(prompt: string, active: ActiveStep, report: TurnReport): string {
  return [
    `> ${prompt}`,
    `tools: ${active.calls.join(', ') || 'none'}`,
    ...(report.foreign.length === 0 ? [] : [`not ours (rejected when asked): ${report.foreign.join(', ')}`]),
    `stop: ${report.stopReason}`,
    report.text,
  ].join('\n');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
