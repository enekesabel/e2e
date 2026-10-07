/**
 * One ACP agent process and one session in it.
 *
 * The agent process starts in the project directory, so a command installed
 * there resolves, and gets `initialize` and one `session/new` in an empty
 * temporary directory with the step tools as its only MCP server. The
 * client advertises no file system or terminal capability, and answers
 * permission requests itself: calls of the step tools are allowed, anything
 * else is rejected. Each `prompt` is one `session/prompt` and resolves when
 * the agent's turn ends.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type ToolCallUpdate,
  type Usage,
} from '@agentclientprotocol/sdk';
import { MCP_SERVER_NAME, serveTools, type ServedTool, type ToolServer } from './mcp.ts';
import type { AcpExecutorOptions } from './types.ts';

/** Tool kinds an agent uses for its own built-in tools; never a call of ours, whatever the title says. */
const BUILT_IN_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'switch_mode']);

/** What one prompt turn reported. */
export interface TurnReport {
  readonly startedAt: string;
  readonly durationMs: number;
  readonly stopReason: string;
  readonly usage?: Usage;
  /** The turn's cost in USD, when the agent reports a session cost. */
  readonly costUsd?: number;
  /** The agent's text replies during the turn. */
  readonly text: string;
  /** Tool calls of the agent's own it reported or asked permission for: not ours, so rejected when asked. */
  readonly foreign: readonly string[];
}

/** A running agent session. */
export interface AcpSession {
  prompt(text: string): Promise<TurnReport>;
  /** Cancels the turn in flight, if any. */
  cancel(): void;
  close(): void;
  /** The model the session runs, when the agent names it. */
  readonly modelId: string | undefined;
  readonly agentName: string | undefined;
}

/**
 * Starts the agent, initializes it, and opens a session with the tools.
 * Aborting `signal` before the session is open stops the agent and the tool
 * server and rejects.
 */
export async function startSession(options: AcpExecutorOptions, tools: readonly ServedTool[], signal: AbortSignal): Promise<AcpSession> {
  signal.throwIfAborted();
  const cwd = mkdtempSync(join(tmpdir(), 'e2e-acp-'));
  let server: ToolServer | undefined;
  const child = spawn(options.command, [...(options.args ?? [])], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env },
  });
  let stderr = '';
  child.stderr.on('data', (data: Buffer) => {
    stderr = (stderr + data.toString()).slice(-2000);
  });
  // A dead agent must not take the test worker down with a pipe error.
  child.stdin.on('error', () => undefined);
  const exited = new Promise<never>((_, reject) => {
    child.on('error', (error) => reject(new Error(`could not start ${options.command}: ${error.message}`)));
    child.on('exit', (code, exitSignal) =>
      reject(new Error(`the agent exited (${exitSignal ?? `code ${code}`})${stderr === '' ? '' : `: ${lastLine(stderr)}`}`)),
    );
  });
  exited.catch(() => undefined);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('the attempt ended while the agent was starting'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  /** Ends a startup step early when the agent exits or the attempt ends. */
  const startup = <T>(step: Promise<T>): Promise<T> => Promise.race([exited, aborted, step]);

  const calls = new Map<string, Partial<ToolCallUpdate>>();
  const turn = { cost: undefined as number | undefined, text: '', foreign: new Map<string, string>() };
  const client: Client = {
    requestPermission: (params) => answerPermission(params, calls, turn.foreign),
    sessionUpdate: (params) => observe(params, calls, turn),
  };
  const connection = new ClientSideConnection(
    () => client,
    ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
  );
  const teardown = () => {
    child.stdin.end();
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 3_000).unref();
    void server?.close();
    rmSync(cwd, { recursive: true, force: true });
  };

  let initialize: InitializeResponse;
  let sessionId: string;
  let modelId: string | undefined;
  try {
    server = await startup(serveTools(tools));
    initialize = await startup(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'e2e', version: '1' },
      }),
    );
    if (initialize.agentCapabilities?.mcpCapabilities?.http !== true) {
      throw new Error(`${options.command} does not accept MCP servers over HTTP`);
    }
    const session = await startup(
      connection.newSession({
        cwd,
        mcpServers: [{ type: 'http', name: MCP_SERVER_NAME, url: server.url, headers: [] }],
        ...(options.sessionMeta === undefined ? {} : { _meta: { ...options.sessionMeta } }),
      }),
    );
    sessionId = session.sessionId;
    const modelOption = session.configOptions?.find((option) => option.category === 'model' || option.id === 'model');
    if (options.model !== undefined) {
      const offered = modelOption === undefined ? [] : selectValues(modelOption);
      if (modelOption === undefined || !offered.includes(options.model)) {
        throw new Error(
          `the agent does not offer model ${options.model}${offered.length === 0 ? '' : `; it offers ${offered.join(', ')}`}`,
        );
      }
      await startup(connection.setSessionConfigOption({ sessionId, configId: modelOption.id, value: options.model }));
      modelId = options.model;
    } else if (modelOption?.type === 'select') {
      modelId = String(modelOption.currentValue);
    }
    if (options.mode !== undefined) await startup(selectMode(connection, session, options.mode));
  } catch (error) {
    teardown();
    throw error;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }

  let closed = false;
  return {
    modelId,
    agentName: initialize.agentInfo?.name,
    async prompt(text) {
      turn.text = '';
      turn.foreign = new Map();
      const costBefore = turn.cost;
      const started = Date.now();
      const response = await Promise.race([connection.prompt({ sessionId, prompt: [{ type: 'text', text }] }), exited]);
      const costUsd = turn.cost === undefined ? undefined : turn.cost - (costBefore ?? 0);
      return {
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        stopReason: response.stopReason,
        ...(response.usage == null ? {} : { usage: response.usage }),
        ...(costUsd === undefined ? {} : { costUsd }),
        text: turn.text,
        foreign: [...turn.foreign.values()],
      };
    },
    cancel() {
      void connection.cancel({ sessionId }).catch(() => undefined);
    },
    close() {
      if (closed) return;
      closed = true;
      void (async () => {
        if (initialize.agentCapabilities?.sessionCapabilities?.close != null) {
          await Promise.race([
            connection.closeSession({ sessionId }).catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, 2_000).unref()),
          ]);
        }
        teardown();
      })();
    },
  };
}

async function selectMode(
  connection: ClientSideConnection,
  session: Awaited<ReturnType<ClientSideConnection['newSession']>>,
  mode: string,
): Promise<void> {
  const option = session.configOptions?.find((entry) => entry.category === 'mode');
  if (option !== undefined && selectValues(option).includes(mode)) {
    await connection.setSessionConfigOption({ sessionId: session.sessionId, configId: option.id, value: mode });
  } else if (session.modes?.availableModes.some((entry) => entry.id === mode) === true) {
    await connection.setSessionMode({ sessionId: session.sessionId, modeId: mode });
  } else {
    throw new Error(`the agent has no mode ${mode}`);
  }
}

/** The values of a select config option, groups flattened. */
function selectValues(option: SessionConfigOption): string[] {
  if (option.type !== 'select') return [];
  return option.options.flatMap((entry) => ('group' in entry ? entry.options.map((inner) => inner.value) : [entry.value]));
}

function observe(
  { update }: SessionNotification,
  calls: Map<string, Partial<ToolCallUpdate>>,
  turn: { cost: number | undefined; text: string; foreign: Map<string, string> },
): void {
  switch (update.sessionUpdate) {
    case 'tool_call':
    case 'tool_call_update': {
      const { sessionUpdate: _, ...fields } = update;
      calls.set(update.toolCallId, { ...calls.get(update.toolCallId), ...defined(fields) });
      if (update.sessionUpdate === 'tool_call' && !isOurs(update, undefined)) turn.foreign.set(update.toolCallId, update.title ?? update.kind ?? 'tool');
      break;
    }
    case 'agent_message_chunk':
      if (update.content.type === 'text') turn.text += update.content.text;
      break;
    case 'usage_update':
      if (update.cost != null && update.cost.currency === 'USD') turn.cost = update.cost.amount;
      break;
    default:
      break;
  }
}

/** Allows calls of the step tools; rejects everything else. */
function answerPermission(
  params: RequestPermissionRequest,
  calls: Map<string, Partial<ToolCallUpdate>>,
  foreign: Map<string, string>,
): RequestPermissionResponse {
  const toolCall = { ...calls.get(params.toolCall.toolCallId), ...defined(params.toolCall) };
  const allowed = isOurs(toolCall, params['_meta'] ?? undefined);
  if (!allowed) foreign.set(params.toolCall.toolCallId, toolCall.title ?? toolCall.kind ?? 'tool');
  const kinds = allowed ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  const option = kinds.map((kind) => params.options.find((entry) => entry.kind === kind)).find((entry) => entry !== undefined);
  return option === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: option.optionId } };
}

/**
 * Whether a tool call is one of ours. ACP has no standard field for the MCP
 * server behind a call, so this reads what the adapters report: the Claude
 * adapter's `_meta.claudeCode`, the Codex adapter's MCP approval marker and
 * raw input, and otherwise a call that is not a built-in kind and names our
 * server in its title or input.
 */
function isOurs(toolCall: Partial<ToolCallUpdate>, requestMeta: Record<string, unknown> | undefined): boolean {
  const meta = (toolCall['_meta'] ?? {}) as { claudeCode?: { toolName?: unknown } };
  if (meta.claudeCode !== undefined) {
    return typeof meta.claudeCode.toolName === 'string' && meta.claudeCode.toolName.startsWith(`mcp__${MCP_SERVER_NAME}__`);
  }
  const raw = (toolCall.rawInput ?? {}) as { serverName?: unknown; server?: unknown };
  if (requestMeta?.['is_mcp_tool_approval'] === true) return raw.serverName === MCP_SERVER_NAME || raw.server === MCP_SERVER_NAME;
  if (toolCall.kind != null && BUILT_IN_KINDS.has(toolCall.kind)) return false;
  return [toolCall.title, JSON.stringify(toolCall.rawInput ?? null)].some(
    (field) => typeof field === 'string' && field.includes(MCP_SERVER_NAME),
  );
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined && field !== null)) as Partial<T>;
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1) ?? '';
}
