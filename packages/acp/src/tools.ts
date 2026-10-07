/**
 * The tools a session offers: the engine's action grammar, `observe`, and
 * `complete_step`. They are built once per session and act on whichever
 * step is active when the agent calls them, so one conversation serves every
 * step of a test. Every action goes through `ctx.actions`, where the runner
 * authorizes, counts, and records it, so steps replay from the cache as the
 * built-in agent's do.
 */

import { isAgentError, type ExecutorVerb, type StepExecutorContext, type StepVerdict } from 'e2e';
import { z } from 'zod';
import type { ServedTool } from './mcp.ts';

/** Error codes the runtime owns: they end the step and are rethrown untouched, never shown to the agent as an action failure. */
const RUNTIME_CODES = new Set(['STEP_BUDGET_EXHAUSTED', 'STEP_TIMEOUT', 'CANCELLED']);

/** The step a session serves now. */
export interface ActiveStep {
  readonly ctx: StepExecutorContext;
  verdict: StepVerdict | undefined;
  /** A runtime error a tool hit; the turn is cancelled and `runStep` rethrows it. */
  halted: unknown;
  /** Tool names in call order, for the transcript. */
  readonly calls: string[];
}

/** Where the tools find the active step, and how a tool ends the turn early. */
export interface StepSlot {
  active: ActiveStep | undefined;
  /** Called when a tool hit a runtime error: cancels the agent's turn. */
  halt(): void;
}

const id = z.string().describe('node id from the latest screen, e.g. n42');
const direction = z.enum(['up', 'down', 'left', 'right']);
const target = (value: unknown) => ({ id: String(value).replace(/^#/, '') });

/** One action tool: the verb it needs, its input, and the call into `ctx.actions`. */
interface ActionSpec {
  readonly name: string;
  readonly verb: ExecutorVerb;
  readonly description: string;
  readonly input: z.ZodObject;
  readonly act: (ctx: StepExecutorContext, args: Record<string, unknown>) => Promise<unknown>;
}

const ACTIONS: readonly ActionSpec[] = [
  { name: 'tap', verb: 'tap', description: 'Tap (click) a node.', input: z.object({ id }).strict(), act: (ctx, a) => ctx.actions.tap(target(a['id'])) },
  { name: 'double_tap', verb: 'doubleTap', description: 'Double-tap a node.', input: z.object({ id }).strict(), act: (ctx, a) => ctx.actions.doubleTap(target(a['id'])) },
  { name: 'long_press', verb: 'longPress', description: 'Press and hold a node.', input: z.object({ id }).strict(), act: (ctx, a) => ctx.actions.longPress(target(a['id'])) },
  { name: 'secondary_tap', verb: 'secondaryTap', description: 'Right-click a node.', input: z.object({ id }).strict(), act: (ctx, a) => ctx.actions.secondaryTap(target(a['id'])) },
  { name: 'hover', verb: 'hover', description: 'Move the pointer over a node without pressing.', input: z.object({ id }).strict(), act: (ctx, a) => ctx.actions.hover(target(a['id'])) },
  {
    name: 'type',
    verb: 'type',
    description: 'Replace the text of a field.',
    input: z.object({ id, value: z.string() }).strict(),
    act: (ctx, a) => ctx.actions.type(target(a['id']), String(a['value'])),
  },
  {
    name: 'type_secret',
    verb: 'typeSecret',
    description: 'Fill a secret the step declares into a field, by the secret\'s name. You never see the value.',
    input: z.object({ id, name: z.string() }).strict(),
    act: (ctx, a) => ctx.actions.typeSecret(target(a['id']), String(a['name'])),
  },
  {
    name: 'press',
    verb: 'press',
    description: 'Press a key on a node, e.g. Enter.',
    input: z.object({ id, key: z.string() }).strict(),
    act: (ctx, a) => ctx.actions.press(target(a['id']), String(a['key'])),
  },
  {
    name: 'select',
    verb: 'select',
    description: 'Choose an option of a select by its label.',
    input: z.object({ id, value: z.string() }).strict(),
    act: (ctx, a) => ctx.actions.select(target(a['id']), String(a['value'])),
  },
  {
    name: 'check',
    verb: 'check',
    description: 'Set a checkbox, switch, or radio to checked or unchecked. Leaves it alone when it is already in that state.',
    input: z.object({ id, checked: z.boolean() }).strict(),
    act: (ctx, a) => ctx.actions.check(target(a['id']), a['checked'] === true),
  },
  {
    name: 'drag',
    verb: 'drag',
    description: 'Drag one node onto another.',
    input: z.object({ source: id, destination: id }).strict(),
    act: (ctx, a) => ctx.actions.drag(target(a['source']), target(a['destination'])),
  },
  { name: 'scroll_to', verb: 'scrollTo', description: 'Bring a listed node into view.', input: z.object({ id }).strict(), act: (ctx, a) => ctx.actions.scrollTo(target(a['id'])) },
  {
    name: 'scroll_until',
    verb: 'scrollUntil',
    description: 'Scroll the page, or a list by id, until a node reading `text` is in view: for a row the screen does not list yet.',
    input: z.object({ text: z.string(), direction, list: id.optional() }).strict(),
    act: (ctx, a) =>
      ctx.actions.scrollUntil(String(a['text']), a['direction'] as 'down', a['list'] === undefined ? undefined : target(a['list'])),
  },
  {
    name: 'scroll',
    verb: 'scroll',
    description: 'Scroll the page, or a list by id, one screen.',
    input: z.object({ direction, id: id.optional() }).strict(),
    act: (ctx, a) => ctx.actions.scroll(a['direction'] as 'down', a['id'] === undefined ? undefined : target(a['id'])),
  },
  {
    name: 'navigate',
    verb: 'navigate',
    description: 'Open an http(s) URL or a path of the app.',
    input: z.object({ url: z.string() }).strict(),
    act: (ctx, a) => ctx.actions.navigate(String(a['url'])),
  },
  { name: 'back', verb: 'back', description: 'Go back one page.', input: z.object({}).strict(), act: (ctx) => ctx.actions.back() },
];

/** The session's tools, for the verbs the target's engine supports. */
export function stepTools(slot: StepSlot, verbs: ReadonlySet<ExecutorVerb>): ServedTool[] {
  const current = (name: string): ActiveStep => {
    const active = slot.active;
    if (active === undefined || active.verdict !== undefined || active.halted !== undefined) {
      throw new Error('No step is active. Wait for the next instruction.');
    }
    active.calls.push(name);
    return active;
  };
  /** Runs a tool body against the active step; a runtime error ends the turn, anything else goes back to the agent as the call's error. */
  const guarded =
    (name: string, body: (active: ActiveStep) => Promise<string>) =>
    async (): Promise<{ text: string; isError?: boolean }> => {
      let active: ActiveStep | undefined;
      try {
        active = current(name);
        return { text: await body(active) };
      } catch (error) {
        if (active !== undefined && isAgentError(error) && RUNTIME_CODES.has(error.code)) {
          active.halted = error;
          slot.halt();
          return { text: `The step has ended (${error.code}). Stop and wait for the next instruction.`, isError: true };
        }
        return { text: `${name} failed: ${firstLine(error)}`, isError: true };
      }
    };
  const tools: ServedTool[] = [
    {
      name: 'observe',
      description: 'Read the current screen.',
      inputSchema: z.object({}).strict(),
      readOnly: true,
      run: guarded('observe', async ({ ctx }) => screen(ctx)),
    },
  ];
  for (const spec of ACTIONS) {
    if (!verbs.has(spec.verb)) continue;
    tools.push({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.input,
      readOnly: false,
      run: (args) =>
        guarded(spec.name, async ({ ctx }) => {
          if (ctx.step.kind === 'assert') {
            throw new Error('this step is an assertion: read the screen and conclude, do not act');
          }
          await spec.act(ctx, args);
          return `${spec.name} done.\n\n${await screen(ctx)}`;
        })(),
    });
  }
  tools.push({
    name: 'complete_step',
    description:
      'End the current step. For an action step, "passed" when the screen shows the outcome the step asked for. For an assertion, "passed" when the condition holds on the current screen. "failed" otherwise, saying why.',
    inputSchema: z.object({ status: z.enum(['passed', 'failed']), summary: z.string() }).strict(),
    readOnly: true,
    run: (args) =>
      guarded('complete_step', async (active) => {
        const summary = String(args['summary']).trim() || 'no summary given';
        active.verdict =
          args['status'] === 'passed'
            ? { status: 'passed', summary }
            : { status: 'failed', summary, errorCode: active.ctx.step.kind === 'assert' ? 'ASSERTION_FAILED' : 'ACTION_FAILED' };
        return 'Step recorded. Wait for the next instruction.';
      })(),
  });
  return tools;
}

/** The current screen as the agent reads it. */
export async function screen(ctx: StepExecutorContext): Promise<string> {
  const observation = await ctx.observe();
  const location = observation.path === undefined ? '' : `Location: ${observation.path}\n`;
  const truncated = observation.truncated ? '\n(The screen was cut to fit; scroll to read more.)' : '';
  return `Current screen:\n${location}${observation.text}${truncated}`;
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
}
