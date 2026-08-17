/**
 * Default one-shot summarization and durable checkpoint framing.
 *
 * @module @deepseek-ai/dsh-compaction-basic/summarizer
 */

import type { Context } from '@deepseek-ai/cordis'
import { contentHasImage, createUserMessage, BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, Message, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

interface SummaryConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
}

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * The replayed conversation surface the summarizer condenses. Reproducing the
 * last routed request's system prompt, tools, and leading messages verbatim
 * lets the auxiliary call reuse the provider's warm prefix cache; the trailing
 * compaction instruction is then the only novel input.
 */
export interface SummarizationInput {
  /** The conversation's own system prompt, reused for prefix-cache alignment; absent for a system-less request. */
  readonly system?: string
  /** The conversation's tool schemas, reused for prefix-cache alignment; absent when the request carried none. */
  readonly tools?: readonly ToolSchema[]
  /** The shadowed region, in surface order, that precedes the compaction instruction. */
  readonly messages: readonly Message[]
}

/** Safe summary content plus the exact auxiliary call envelope recorded with it. */
export type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  /** Provider-reported usage for this summarization request. */
  usage?: TokenUsage
} & (
  | {
    /** Complete provider output before the text-only summary projection. */
    rawOutput: ContentBlock[]
    /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
    llmStreamCall: true
  }
  | {
    /** Optional complete output from an unmarked template, remote, or other summarizer. */
    rawOutput?: ContentBlock[]
    /** An unmarked result does not identify a call through this context's LLM seam. */
    llmStreamCall?: never
  }
)

/**
 * Run the default cache-reusing `ctx.llm.stream()` summarization call: replay
 * the conversation prefix, then append the compaction instruction as the final
 * user message so the provider's warm prefix cache is reused.
 * @param ctx - context providing the LLM service.
 * @param config - resolved backend configuration.
 * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
 * @param agent - supplies routed-model history, fallback model, and session id.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns safe text-only summary blocks and the exact call envelope and output.
 */
export async function summarizeWithLlm(
  ctx: Context,
  config: SummaryConfig,
  input: SummarizationInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const latest = agent.session.requestHeader()?.config
  const configured = config.summarizationProvider.length === 0
    ? undefined
    : { provider: config.summarizationProvider, model: config.summarizationModel }
  const agentTarget = agent.options.provider !== undefined
    && agent.options.provider.length > 0
    && agent.options.model !== undefined
    && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? latest ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
    )
  }

  const assembler = new BlockAssembler()
  const messages: Message[] = [
    ...input.messages,
    createUserMessage({
      content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
      source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
    }),
  ]
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    ...input.system === undefined ? {} : { system: input.system },
    ...input.tools === undefined ? {} : { tools: [...input.tools] },
    maxTokens: config.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error

  const rawOutput = assembler.blocks()
  const summary = summaryText(rawOutput)
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: config.maxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/**
 * Wrap raw summary blocks in the durable checkpoint framing.
 * @param summary - safe text-only model output.
 * @returns content for the synthesized replacement user message.
 */
export function frameSummary(summary: readonly ContentBlock[]): ContentBlock[] {
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
    ...summary,
    { type: 'text', text: SUMMARY_CLOSE_TAG },
  ]
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Reject visual output and keep only text before synthesizing a user message. */
function summaryText(
  blocks: readonly ContentBlock[],
): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}
/**
 * Agent-driven summarization: ask the agent itself to condense its own
 * conversation. The conversation history IS the agent's context, so the model
 * request that produces the summary is a direct continuation of the live
 * session — the provider's KV cache for the prefix is warm, no giant replay
 * payload is ever assembled, and the session can be arbitrarily large.
 *
 * The agent's summarizing turn appends its own assistant message to the
 * surface; the replacement checkpoint shadows the span selected BEFORE this
 * turn, so the summary action itself stays visible in the session log.
 *
 * @param ctx - plugin context (used only for logging).
 * @param agent - the agent that owns the conversation; must be idle with an
 *   empty inbox (the manual compaction path checks this before calling).
 * @param signal - optional cancellation: aborts the summarizing turn.
 * @returns the text-only summary plus the agent's route as the call envelope.
 */
export const AGENT_COMPACTION_INSTRUCTION = [
  'A compaction checkpoint is needed: this conversation has grown too large to continue efficiently. Produce the checkpoint summary for the ENTIRE conversation history you can see (including any earlier <compacted-summary> block).',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Do NOT call any tool, run any code, or take any other action: your entire reply becomes the checkpoint.',
  '- The summary must be substantially shorter than the conversation (a few thousand tokens at most); if the conversation already contains a <compacted-summary> block, merge it with newer information into ONE consolidated summary instead of copying it forward.',
].join('\n')

/**
 * 等总结轮完成（busy 会话替代 whenIdle）：指令后第一个新 turn 的 assistant 消息出现后，
 * 一旦观察到更新的 turn（或超时）即视为总结轮结束。
 */
async function waitSummaryTurn(
  session: { readonly events: ReadonlyArray<{ readonly type?: string; readonly data?: unknown }> },
  seqFloor: number,
  timeoutMs: number,
): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const start = Date.now()
  let targetTurn: number | null = null
  while (Date.now() - start < timeoutMs) {
    let lastTurn = -1
    for (let index = seqFloor; index < session.events.length; index += 1) {
      const event = session.events[index]
      if (event === undefined || event.type !== 'assistant/message') continue
      const turn = (event.data as { turn?: number } | undefined)?.turn ?? -1
      if (turn > lastTurn) lastTurn = turn
    }
    if (lastTurn >= 0) {
      if (targetTurn === null) targetTurn = lastTurn
      else if (lastTurn > targetTurn) return // 新 turn 开始 = 总结轮完成
    }
    await sleep(1000)
  }
}

/**
 * Deliver the compaction instruction to the agent and capture its summarizing
 * reply as the checkpoint summary.
 * @param ctx - plugin context (for logging).
 * @param agent - the owning agent; must be idle with an empty inbox.
 * @param signal - optional cancellation forwarded to the summarizing turn.
 * @returns the summary result (route envelope from the agent's own options).
 */
export async function agentSummarize(
  ctx: Context,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const session = agent.session
  // Snapshot before the injection: everything appended from here on belongs to
  // the summarizing turn and must not be shadowed.
  const seqFloor = session.events.length

  const onAbort = (): void => {
    try {
      agent.cancel({ kind: 'hook', reason: 'agent-compact: summarization cancelled' }, { keepInbox: true })
    } catch {
      // Best effort: cancellation is advisory; whenIdle still settles.
    }
  }
  if (signal !== undefined) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    agent.send(
      createUserMessage({
        content: [{ type: 'text', text: AGENT_COMPACTION_INSTRUCTION }],
        source: { kind: 'plugin', plugin: 'dsh-agent-compact' },
      }),
      'next-turn',
      true,
    )
    // busy 会话修复：agent.whenIdle() 等「agent 完全无活动」——对话中的 agent 每轮都在动，
    // 永不 resolve → 压缩挂起。改为等「总结轮 turn 完成」：指令后第一个新 turn 出现
    // assistant 消息后，一旦出现更新的 turn 即视为总结轮结束。
    await waitSummaryTurn(session, seqFloor, 120000)
  } finally {
    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
  }
  if (signal?.aborted) throw new LlmError('agent summarization was cancelled', 'ABORTED')

  // 捕获总结轮（targetTurn）的 assistant 消息——不是「最后一个」（后续轮会污染）
  let message: Message | undefined
  let usage: TokenUsage | undefined
  const events = session.events
  let targetTurn: number | undefined
  for (let index = seqFloor; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    const turn = (event.data as { turn?: number }).turn
    if (targetTurn === undefined) targetTurn = turn
    if (turn !== targetTurn) continue // 只取总结轮
    message = event.data.message
    if (event.data.usage !== undefined) usage = event.data.usage
  }
  if (message === undefined) {
    throw new Error('agent summarization produced no assistant message')
  }
  const summary = summaryText(message.content)
  if (!summary.some((block) => block.text.trim().length > 0)) {
    throw new Error('agent summarization produced no text summary content')
  }
  const target = {
    provider: agent.options.provider ?? '',
    model: agent.options.model ?? '',
  }
  return {
    summary,
    rawOutput: message.content,
    provider: target.provider,
    model: target.model,
    ...usage === undefined ? {} : { usage },
  }
}