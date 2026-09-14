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
import { trace } from './trace.ts'

/** 会话 id 前缀（多会话并存时区分轨迹；结构存取以避开 branded 类型）。 */
function sessionTag(session: unknown): string | undefined {
  const id = (session as { id?: unknown } | null)?.id
  return typeof id === 'string' && id !== '' ? id.slice(0, 8) : undefined
}

interface SummaryConfig {
  readonly summarizationProvider: string
  readonly summarizationModel: string
  readonly maxTokens: number
}

/** Tags wrapping the structured summary inside the landed checkpoint node. */
const SUMMARY_OPEN_TAG = '<compacted-summary>'
const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/**
 * 可信 checkpoint 的最小字符数（2026-09-13 碎片拒收地板）。
 * 真实 checkpoint 的量级是数千字符（历史样本 4637 / 4685 / 5599）；低于地板只可能是
 * 「捕获到了别的东西」（事故：117 字符的工作前言）→ fail loud 让压缩失败可见，而不是静默损坏历史。
 */
const MIN_PLAUSIBLE_SUMMARY_CHARS = 200

/**
 * 「指令进入表层」的等待上限与轮询间隔（2026-09-14 实测给定）。
 *
 * 为什么需要等待：表层的落地时机**不固定**——健康样本里表层(5972)先于摘要(5973)，
 * 而失败样本里摘要在前、表层出现在**下一个 turn 边界**(7951)。总结轮一结束就判定
 * "没进表层"会误杀正常压缩（0.1.2 首日实测：一次真实压缩被自己的闸门拦下）。
 * 8 秒上限是"够短、不至于把坏样本拖太久"与"够长、覆盖一个 turn 边界"的折中。
 */
const SURFACE_WAIT_MS = 8000
const SURFACE_POLL_MS = 500

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

/** 总结轮的候选 assistant 消息（同一 turn 内可有多条——一个 turn 含多个 step）。 */
export interface SummaryCandidate {
  turn: number | undefined
  /** 该消息文本块拼接（判定用） */
  text: string
}

/**
 * 从总结轮的候选消息中**按判据**选出承载 checkpoint 的那一条（纯函数，可离线单测）。
 *
 * 2026-09-13 事故：总结轮内可有多条 assistant 消息——我在输出 checkpoint（5599 字符、含
 * `<compacted-summary>`）之后，又在**同一轮**里继续干活（工具调用 × 4），旧实现「后者覆盖前者」
 * 取到最后一条 → 捕获到 117 字符的工作前言，真正的 checkpoint 被丢弃：
 * 记忆「保底存档」与**会话表层替换体**双错（旧历史被 117 字符替换）。
 *
 * 判据（依序）：① 含 `<compacted-summary>` 块者优先（其中取最长）；② 否则取文本最长者
 * （指令要求「整条回复即 checkpoint」，工作前言恒短于 checkpoint）；③ 全空 → null（调用方 fail loud）。
 * 显式排除「取最后一条」——顺序与语义无关，长度/标记才有关系。
 */
export function selectSummaryCandidate(
  candidates: readonly SummaryCandidate[],
): { index: number; reason: string } | null {
  let tagged = -1
  let taggedLen = -1
  let longest = -1
  let longestLen = -1
  for (let index = 0; index < candidates.length; index += 1) {
    const text = candidates[index]!.text
    const length = text.trim().length
    if (length === 0) continue
    if (length > longestLen) {
      longest = index
      longestLen = length
    }
    if (text.includes(SUMMARY_OPEN_TAG) || text.includes(SUMMARY_CLOSE_TAG)) {
      if (length > taggedLen) {
        tagged = index
        taggedLen = length
      }
    }
  }
  if (tagged >= 0) {
    return { index: tagged, reason: '含 <compacted-summary> 块（' + String(taggedLen) + ' 字符）' }
  }
  if (longest >= 0) {
    return {
      index: longest,
      reason: '无标记块 → 取最长文本（' + String(longestLen) + ' 字符 / 共 ' + String(candidates.length) + ' 条候选）',
    }
  }
  return null
}

/**
 * 等总结轮完成（busy 会话替代 whenIdle）：指令后第一个新 turn 的 assistant 消息出现后，
 * 一旦观察到更新的 turn（或超时）即视为总结轮结束。
 */
async function waitSummaryTurn(
  session: { seq: number; eventAt(seq: number): { readonly type?: string; readonly data?: unknown } | undefined },
  seqFloor: number,
  timeoutMs: number,
): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const start = Date.now()
  let targetTurn: number | null = null
  while (Date.now() - start < timeoutMs) {
    let lastTurn = -1
    let targetTurnEnded = false
    for (let index = seqFloor; index < session.seq; index += 1) {
      const event = session.eventAt(index)
      if (event === undefined) continue
      if (event.type === 'assistant/message') {
        const turn = (event.data as { turn?: number } | undefined)?.turn ?? -1
        if (turn > lastTurn) lastTurn = turn
      } else if (event.type === 'turn/end') {
        // 2026-09-13 修复：目标轮**封口**即可收尾。旧实现只认「更新的 turn 出现」，而 agent 可在
        // 同一轮里持续工作（输出 checkpoint 后继续调工具 → 一直不出新 turn）→ 白等满 120s
        // （实测 compaction/start 11:06:48 → summary 11:08:48 = 120.0s，正好是这里的 timeout）。
        const endedTurn = (event.data as { turn?: number } | undefined)?.turn
        if (targetTurn !== null && endedTurn === targetTurn) targetTurnEnded = true
      }
    }
    if (lastTurn >= 0) {
      if (targetTurn === null) targetTurn = lastTurn
      else if (lastTurn > targetTurn) return // 新 turn 开始 = 总结轮完成
    }
    if (targetTurnEnded) return
    await sleep(1000)
  }
}

/** 总结指令在模型可见表层出现的证据。 */
export interface InstructionSurfaceEvidence {
  /** 表层是否出现过该指令。 */
  surfaced: boolean
  /** 出现过该指令的表层事件 seq 列表。 */
  seqs: number[]
}

/**
 * 从会话事件里抽出全部文本块（**形状宽容**）。
 *
 * 为什么必须宽容（2026-09-14 事故）：`user/message` 在事件流里有两种载体形状——
 *   ① `data.content: [{type:'text', text}]` ← **实测的真实形状**（inbox 排空后落到表层就是它）
 *   ② `data.message.content: [...]` ← 另一条链路
 * 初版只读 ② ⇒ 对 ① 恒返回 false ⇒ 闸门 100% 假拒绝：0.1.2 上线后第一次真实压缩直接被拦
 * （compaction/end seq=7952，上下文卡在 512k 未缩小）。
 * 教训：**形状要按实测取证，不能按记忆里的"另一种写法"**。
 * @param data - 事件 `data` 字段
 * @returns 全部文本块拼接
 */
export function textOfEventData(data: unknown): string {
  const parts: string[] = []
  const push = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const block of value) {
      const candidate = block as { text?: unknown } | null
      if (candidate !== null && typeof candidate === 'object' && typeof candidate.text === 'string') {
        parts.push(candidate.text)
      }
    }
  }
  const record = data as { content?: unknown; message?: { content?: unknown }; inserted?: unknown } | null
  if (record !== null && typeof record === 'object') {
    push(record.content)                                 // ① 实测形状
    push(record.message?.content)                        // ② 兼容形状
    if (Array.isArray(record.inserted)) {                // ③ 入队事件的 inserted[].content
      for (const item of record.inserted) push((item as { content?: unknown } | null)?.content)
    }
  }
  return parts.join('\n')
}

/**
 * 判据：总结指令是否**真的进入过模型可见表层**。
 *
 * 为什么需要这条前置条件（2026-09-13 事件流取证）：投递管线里「入队」
 * （`agent/inbox/spliced` 带 inserted）与「排空」（同类型事件带 removedCount）只是**同一次
 * 投递的两个生命周期事件**——把它们当两次投递会误判成「双投递」（旧版取证脚本正是如此，
 * 已证伪）。真正决定成败的是**表层**：只有当指令出现在 `user/message` 里，模型才可能产出
 * checkpoint。turn 29（compaction 9ce76cec）实测 queued=1 / surfaced=0：指令入队却没进表层，
 * 120s 超时后捕获到了别的工作文本（117 字符，由长度下限拒收）。
 *
 * **顺序不固定（2026-09-14 实测）**：健康样本里表层(5972)在摘要(5973)之前；失败样本里摘要
 * (7945)在表层(7951)之前（表层出现在**下一个 turn 边界**）⇒ 调用方必须允许短暂重查，
 * 不得假定"总结轮结束时表层一定已存在"（见 `agentSummarize` 里的等待重查）。
 *
 * @param view - 会话事件视图（当前 seq + 按序取事件）
 * @param seqFloor - 注入前的 seq 下界：只有其后的表层事件才属于总结轮
 * @param instruction - 期望出现的指令文本（默认 {@link AGENT_COMPACTION_INSTRUCTION}）
 * @returns 表层证据：是否出现 + 出现位置
 */
export function instructionSurfaced(
  view: { seq: number; eventAt(seq: number): { type?: string; data?: unknown } | undefined },
  seqFloor: number,
  instruction: string = AGENT_COMPACTION_INSTRUCTION,
): InstructionSurfaceEvidence {
  // 比对用前缀：口令文本可能被微调，60 字符前缀足以判定「是同一条指令」而不会误配别人的消息
  const needle = instruction.slice(0, 60)
  const seqs: number[] = []
  for (let index = seqFloor; index < view.seq; index += 1) {
    const event = view.eventAt(index)
    if (event === undefined || event.type !== 'user/message') continue
    if (textOfEventData(event.data).includes(needle)) seqs.push(index)
  }
  return { surfaced: seqs.length > 0, seqs }
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
  // alpha.1 适配：session.events 已移除，用 seq + eventAt（宽松结构断言）
  const sessionView = session as unknown as {
    seq: number
    eventAt(seq: number): { type?: string; data?: unknown } | undefined
  }
  // Snapshot before the injection: everything appended from here on belongs to
  // the summarizing turn and must not be shadowed.
  const seqFloor = sessionView.seq
  const sid = sessionTag(session)
  const startedAtMs = Date.now()
  // 轨迹自证（2026-09-14 可维护性）：本插件的过程只进 logger，而宿主 logger 不落盘——
  // 于是「谁发 / 投给谁 / 落地没 / 断在哪段」只能外部反解事件流。这里把关键阶段落成侧车 JSONL。
  trace({ phase: 'begin', seqFloor, session: sid })

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
    trace({ phase: 'queued', seqFloor, session: sid, target: 'next-turn' })
    // busy 会话修复：agent.whenIdle() 等「agent 完全无活动」——对话中的 agent 每轮都在动，
    // 永不 resolve → 压缩挂起。改为等「总结轮 turn 完成」：指令后第一个新 turn 出现
    // assistant 消息后，一旦出现更新的 turn 即视为总结轮结束。
    await waitSummaryTurn(sessionView, seqFloor, 120000)
    trace({ phase: 'waited', seqFloor, session: sid, waitedMs: Date.now() - startedAtMs })
  } finally {
    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
  }
  if (signal?.aborted) throw new LlmError('agent summarization was cancelled', 'ABORTED')

  // 捕获前置条件（2026-09-13）：指令必须真的进过模型可见表层——**入队 ≠ 模型看见**。
  // 拿不到这条证据时宁可压不成（fail loud，compaction/end.error 可见），也不拿可能是
  // 工作前言的文本去替换会话历史。
  // 2026-09-14 补两处（事故复盘）：① 事件形状宽容（真实形状是 data.content，初版只读
  // data.message.content ⇒ 恒 false ⇒ 100% 假拒绝）② 表层落地时机不固定（可能在下个 turn
  // 边界）⇒ 先等一小段再重查，别在总结轮结束的瞬间就判定"没进表层"。
  let surface = instructionSurfaced(sessionView, seqFloor)
  for (let waited = 0; !surface.surfaced && waited < SURFACE_WAIT_MS; waited += SURFACE_POLL_MS) {
    // 就地等待：`sleep` helper 是 waitSummaryTurn 的局部函数，这里不越作用域取它
    await new Promise<void>((resolve) => setTimeout(resolve, SURFACE_POLL_MS))
    surface = instructionSurfaced(sessionView, seqFloor)
  }
  if (!surface.surfaced) {
    const reason = 'agent summarization instruction never reached the model-visible surface after seq '
      + String(seqFloor) + ' within ' + String(SURFACE_WAIT_MS) + 'ms（入队成功但模型未看见）'
      + '——拒绝捕获；同类事故见 compaction 9ce76cec'
    trace({ phase: 'abort', seqFloor, session: sid, error: reason, waitedMs: Date.now() - startedAtMs })
    throw new Error(reason)
  }
  trace({
    phase: 'surfaced', seqFloor, session: sid, surfaceSeqs: surface.seqs,
    waitedMs: Date.now() - startedAtMs,
  })
  ctx.logger.info('总结指令已进入表层：seq=' + surface.seqs.join(','))

  // 捕获总结轮（targetTurn）的 assistant 消息——**按判据选**，不是「最后一个」：
  // 一个 turn 内可有多条 assistant 消息（输出 checkpoint 后又在同一轮继续工作），
  // 顺序与语义无关，只有「含标记块 / 文本长度」能区分 checkpoint 与工作前言。
  const candidates: Array<{ turn: number | undefined; text: string; message: Message; usage?: TokenUsage }> = []
  let targetTurn: number | undefined
  for (let index = seqFloor; index < sessionView.seq; index += 1) {
    const event = sessionView.eventAt(index)
    if (event === undefined || event.type !== 'assistant/message') continue
    const data = event.data as { turn?: number; message?: Message; usage?: TokenUsage }
    const turn = data.turn
    if (targetTurn === undefined) targetTurn = turn
    if (turn !== targetTurn) continue // 只取总结轮
    if (data.message === undefined) continue
    candidates.push({
      turn,
      text: summaryText(data.message.content).map((block) => block.text).join('\n'),
      message: data.message,
      ...data.usage === undefined ? {} : { usage: data.usage },
    })
  }
  const picked = selectSummaryCandidate(candidates)
  if (picked === null) {
    throw new Error('agent summarization produced no assistant message')
  }
  if (candidates.length > 1) {
    ctx.logger.info('总结轮候选 ' + String(candidates.length) + ' 条 → 选定 #' + String(picked.index)
      + '（' + picked.reason + '；各条长度 ' + candidates.map((c) => c.text.trim().length).join('/') + '）')
  }
  const message = candidates[picked.index]!.message
  const usage = candidates[picked.index]!.usage
  // 碎片拒收（2026-09-13）：宁可压不成，不可压成错的——旧实现用 117 字符的工作前言替换了数千 token
  // 的会话历史。真实 checkpoint 的量级是数千字符（历史样本 4637 / 4685 / 5599），200 字符只可能是
  // 「捕获到了别的东西」，此时 fail loud 让压缩失败可见（compaction/end.error），而不是静默损坏历史。
  const chosenChars = candidates[picked.index]!.text.trim().length
  if (chosenChars < MIN_PLAUSIBLE_SUMMARY_CHARS) {
    const reason = 'agent summarization produced an implausibly small summary ('
      + String(chosenChars) + ' chars < ' + String(MIN_PLAUSIBLE_SUMMARY_CHARS)
      + ')：疑似捕获漂移，拒绝以其替换会话历史'
    trace({
      phase: 'abort', seqFloor, session: sid, chars: chosenChars, error: reason,
      waitedMs: Date.now() - startedAtMs,
    })
    throw new Error(reason)
  }
  const summary = summaryText(message.content)
  if (!summary.some((block) => block.text.trim().length > 0)) {
    throw new Error('agent summarization produced no text summary content')
  }
  const target = {
    provider: agent.options.provider ?? '',
    model: agent.options.model ?? '',
  }
  trace({
    phase: 'captured', seqFloor, session: sid, chars: chosenChars,
    markerOk: candidates[picked.index]!.text.includes(SUMMARY_OPEN_TAG),
    waitedMs: Date.now() - startedAtMs,
  })
  return {
    summary,
    rawOutput: message.content,
    provider: target.provider,
    model: target.model,
    ...usage === undefined ? {} : { usage },
  }
}