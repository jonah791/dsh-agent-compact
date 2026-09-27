/**
 * Agent-driven compaction backend for DeepSeek Harness — **标记即压缩**（0.2.0）.
 *
 * 设计主张（2026-09-27 重设计）：压缩不是「引擎要 agent 总结」，而是「agent 的输出
 * 本身就是压缩请求」。引擎在旁路观察会话事件流；看到一条助手消息里含**合法
 * checkpoint 块**时，把该消息**之前**的历史替换成这份摘要。
 *
 * ⇒ 投递链整体不存在：没有 `agent.send` 指令、没有表层取证、没有等待轮询、没有候选猜测。
 * 三次历史事故（入队未进表层 / 指令被重试吃掉 / 重启后孤儿 checkpoint）长在同一条链上，
 * 它们不是被修好，是被**删掉**。成本同时少一笔全上下文请求（实测意图请求 563k tok）。
 *
 * 框架自动压缩**不存在**：`compactIfNeeded` 恒返回 null，引擎不注册任何 pressure /
 * overflow 监听（AGENTS.md §2.4「禁止框架自动压缩」）。压缩只由 agent 说了算。
 *
 * 事件序列与官方 compaction 事务**字节兼容**（`compaction/start` → `compaction/summary`
 * → `user/message` 三键 replace → `compaction/end`），且闭合在提交那一刻的回合内
 * （满足 0.1.7 读侧硬判据）。
 *
 * @module dsh-agent-compact
 */

import { Context } from '@deepseek-ai/cordis'
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { CHECKPOINT_SENTINEL, frameSummary, parseCheckpointBlock } from './checkpoint-block.ts'
import type { CheckpointBlock } from './checkpoint-block.ts'
import { assistantTextOf, latestCompactionEndSeq, selectMarkerSpan } from './marker.ts'
import { compactableHeadSeq, compactSurfaceRegion, inspectCompactionEntryState } from './region.ts'
import { Config, resolveConfig } from './config.ts'
import type { CompactConfig, ResolvedCompactConfig } from './config.ts'
import { sessionTagOf, trace } from './trace.ts'
import { VERSION } from './version.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-agent-compact': { kind: 'dsh-agent-compact' }
  }
}

export { Config, DEFAULT_MIN_CHECKPOINT_CHARS, resolveConfig } from './config.ts'
export type { CompactConfig, ResolvedCompactConfig } from './config.ts'
export {
  CHECKPOINT_SECTIONS,
  CHECKPOINT_SENTINEL,
  formatCheckpointBlock,
  isInsideFence,
  parseCheckpointBlock,
} from './checkpoint-block.ts'
export type { CheckpointBlock } from './checkpoint-block.ts'
export { assistantTextOf, latestCompactionEndSeq, selectMarkerSpan } from './marker.ts'
export type { MarkerSpan } from './marker.ts'

// 转出侧车轨迹原语（2026-09-14）：让消费方（`dsh-compact-provider` 的工具入口）用**同一份**
// 路径解析/序列化/追加实现写同一个文件——避免两套判据互相漂移（§5.22 规则 4）。
// 走主入口转出而非 package.json 子路径导出：消费方副本的 package.json 由 pnpm 重写，
// 新增子路径导出**不会**同步过去（实测 False）。
export {
  BUILD as compactTraceBuild,
  appendTraceEntry,
  buildStamp,
  compactionTracePath,
  parseTraceEntries,
  readTraceEntries,
  resolveHome as compactTraceResolveHome,
  serializeTraceEntry,
  trace as compactTrace,
} from './trace.ts'
export type { TraceEntry, TracePhase } from './trace.ts'

/** 会话事件视图（宽松结构断言：只需要 seq 与按 seq 取事件）。 */
interface SessionView {
  readonly seq: number
  eventAt(seq: number): { readonly type?: string; readonly data?: unknown } | undefined
  readonly id: string
  readonly surface: { readonly nodes: readonly SessionSeq[] }
}

/** 进程内一次性告警去重（同一 seq 只在首次报告）。 */
const reported = new WeakMap<object, Set<number>>()

/**
 * 标记驱动压缩引擎。
 *
 * 两条入口共用同一个事务：
 * - **标记路径**（主路径，零额外请求）：agent 在自己任意一轮的输出里写合法 checkpoint 块。
 * - **工具路径**（显式）：调用方直接把摘要交给 {@link AgentCompactEngine.compactWithSummary}。
 */
export class AgentCompactEngine extends CompactionEngine {
  static inject = ['agents', 'tokenMeter', 'sessions']

  static Config = Config

  /** 已解析的部署配置。 */
  readonly config: ResolvedCompactConfig

  constructor(ctx: Context, config: CompactConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.enabled) this.registerMarkerPath()
  }

  /**
   * 本引擎**没有自动路径**：不因步间压力或请求溢出自行压缩。
   *
   * 「何时压」是 agent 的决策（AGENTS.md §2.4：主人 2026-08-16「不要开自动压缩，
   * 别让框架强制影响你的决策」）。保留该实现只为满足 seam 契约——恒返回 `null`。
   * @returns 恒为 `null`（永不自动压缩）
   */
  override compactIfNeeded(
    _agent: unknown,
    _trigger: CompactionTrigger,
    _signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    return Promise.resolve(null)
  }

  /**
   * 本引擎**没有引擎发起的压缩**：没有摘要可压。摘要只能来自 agent 自己的输出
   * （标记路径）或显式调用方（工具路径）。
   * @throws {@link ManualCompactionError} 恒抛（`summary` 类），附替代路径说明
   */
  override compactNow(): Promise<CompactionResult | null> {
    return Promise.reject(new ManualCompactionError(
      'summary',
      'agent-driven compaction has no engine-initiated path: the summary must come from the '
      + 'agent\'s own output (checkpoint block) or from an explicit caller. '
      + 'There is no replay summarizer in this backend.',
    ))
  }

  /**
   * 本引擎不做「按 replay 重放总结一个区间」——那条路径需要独立的全量载荷请求，
   * 与「压缩由 agent 自己的输出供给」互斥。
   * @throws {@link ManualCompactionError} 恒抛（`summary` 类）
   */
  override compactRegion(): Promise<CompactionResult> {
    return Promise.reject(new ManualCompactionError(
      'summary',
      'this backend compacts only with a caller-provided checkpoint; range compaction '
      + 'via a replay summarizer is not implemented.',
    ))
  }

  /**
   * 显式入口：用调用方供给的摘要立即压缩「该消息之前」的历史。
   *
   * 与标记路径共用同一事务（同一区间规则、同一事件序列、同一幂等语义）——两条入口
   * 只有「摘要从哪来」不同。
   * @param agent - 会话属主（提供 session 与路由信息）
   * @param summary - checkpoint 正文（调用方负责其内容与体量）
   * @param beforeSeq - 区间终点取「该 seq 在表层的前一个节点」；缺省用 surface 末节点
   * @param sourceCommandId - 事务来源标识（记账用）
   * @returns 压缩结果；无可压区间时为 `null`
   * @throws 事务失败时（摘要不小于被替换内容 / 区间失衡 / 写盘失败）
   */
  async compactWithSummary(
    agent: Agent,
    summary: string,
    beforeSeq?: number,
    sourceCommandId?: string,
  ): Promise<CompactionResult | null> {
    const session = agent.session as unknown as SessionView
    const nodes = session.surface.nodes
    const headSeq = compactableHeadSeq(session as unknown as Session)
    const markerSeq = beforeSeq ?? nodes[nodes.length - 1] ?? 0
    const span = selectMarkerSpan(nodes, markerSeq, headSeq)
    if (span.kind === 'skip') {
      trace({
        phase: 'skipped',
        trigger: 'tool',
        session: sessionTagOf(session),
        chars: summary.length,
        note: span.reason,
      })
      return null
    }
    const startedAt = Date.now()
    const { result, archiveMs, txnMs } = await this.commit(
      session as unknown as Session, span.start as SessionSeq, span.end as SessionSeq,
      agent, summary, 'tool', sourceCommandId,
    )
    trace({
      phase: 'committed', trigger: 'tool', session: sessionTagOf(session),
      chars: summary.length, archiveMs, txnMs, totalMs: Date.now() - startedAt,
      note: 'shadowed ' + String(result.shadowedSeqs.length) + ' nodes (seqs '
        + String(result.shadowedRange.start) + '-' + String(result.shadowedRange.end) + ')',
    })
    return result
  }

  /**
   * 注册标记路径：观察助手消息，识别合法 checkpoint 块并提交事务。
   *
   * 为什么用 `session/event` + `setImmediate`：监听器跑在 `session.append` 内部，
   * 就地再 append 会 reenter（§5.12 规则 4 的同一课）；推迟一个宏任务后，
   * 提交时读到的回合状态就是真实状态（回合内 / 回合间都可提交）。
   */
  private registerMarkerPath(): void {
    this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'assistant/message') return
      const data = event.data as { message?: { content?: unknown } } | undefined
      const text = assistantTextOf(data?.message?.content)
      // 快筛：没有哨兵就不是压缩意图——绝大多数消息在这里返回，零后续成本
      if (!text.includes(CHECKPOINT_SENTINEL)) return
      const parsed = parseCheckpointBlock(text, this.config.minCheckpointChars)
      if (parsed.kind === 'absent') return
      setImmediate(() => {
        void this.handleMarker(session as unknown as SessionView, event.seq, parsed)
      })
    })
  }

  /** 处理一条含哨兵的助手消息：幂等 → 解析结论 → 提交或响亮报告。 */
  private async handleMarker(
    session: SessionView,
    markerSeq: number,
    parsed: Exclude<CheckpointBlock, { kind: 'absent' }>,
  ): Promise<void> {
    const sid = sessionTagOf(session)
    if (parsed.kind === 'invalid') {
      trace({
        phase: 'rejected', trigger: 'marker', session: sid, seqFloor: markerSeq,
        chars: parsed.chars, error: parsed.reason,
      })
      // 「响」优先：写坏一块 checkpoint 不能静默——下个 step 我会看到原因并重写
      this.notifyOnce(session, markerSeq, [
        '⚠ 这次 checkpoint 未生效，会话历史**未改动**。',
        '原因：' + parsed.reason,
        '要压缩请重发一块：首行哨兵 `' + CHECKPOINT_SENTINEL + '`，紧跟 <compacted-summary> 外壳，',
        '正文含全部 8 个 section（Primary Request and Intent … Critical Context），长度 ≥ '
        + String(this.config.minCheckpointChars) + ' 字符，且不要放进围栏代码块。',
      ].join('\n'))
      return
    }

    // 幂等：已处理过的标记消息，其 seq 必然小于此后写入的 compaction/end seq
    const boundary = latestCompactionEndSeq(session)
    if (boundary !== undefined && markerSeq < boundary) {
      trace({
        phase: 'skipped', trigger: 'marker', session: sid, seqFloor: markerSeq,
        note: '已处理过（幂等：seq ' + String(markerSeq) + ' < compaction/end ' + String(boundary) + '）',
      })
      return
    }

    const agent = this.ctx.agents.get(session.id as never)
    if (agent === undefined) {
      // 拿不到属主就压不了：如实记账，不猜、不静默
      trace({
        phase: 'skipped', trigger: 'marker', session: sid, seqFloor: markerSeq,
        note: 'agents 注册表里没有该会话的 agent（无法提交事务）',
      })
      return
    }

    const headSeq = compactableHeadSeq(session as unknown as Session)
    const span = selectMarkerSpan(session.surface.nodes, markerSeq, headSeq)
    if (span.kind === 'skip') {
      trace({ phase: 'skipped', trigger: 'marker', session: sid, seqFloor: markerSeq, note: span.reason })
      return
    }

    trace({
      phase: 'detected', trigger: 'marker', session: sid, seqFloor: markerSeq,
      chars: parsed.chars, agentId: agent.id,
    })
    const startedAt = Date.now()
    try {
      const { result, archiveMs, txnMs } = await this.commit(
        session as unknown as Session,
        span.start as SessionSeq,
        span.end as SessionSeq,
        agent,
        parsed.body,
        'marker',
      )
      trace({
        phase: 'committed', trigger: 'marker', session: sid, seqFloor: markerSeq,
        chars: parsed.chars, archiveMs, txnMs, totalMs: Date.now() - startedAt,
        note: 'shadowed ' + String(result.shadowedSeqs.length) + ' nodes (seqs '
          + String(result.shadowedRange.start) + '-' + String(result.shadowedRange.end) + ')',
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      trace({ phase: 'abort', trigger: 'marker', session: sid, seqFloor: markerSeq, chars: parsed.chars, error: message })
      this.notifyOnce(session, markerSeq, [
        '⚠ 这次 checkpoint 未生效，会话历史**未改动**。',
        '原因：' + message,
      ].join('\n'))
    }
  }

  /**
   * 一个事务：压缩前保命存档 → 表层替换 → flush。两条入口共用。
   *
   * 返回值带**阶段耗时**（2026-09-27 线上首笔实测驱动）：侧车原先只写 `waitedMs: 0`
   * 这个硬编码占位，于是「detected 到 committed 之间那 21.9 秒花在哪」答不出来——
   * §5.22 五问之⑤（耗时与预算）形同虚设。现按「存档 / 事务」两段如实计时。
   */
  private async commit(
    session: Session,
    start: SessionSeq,
    end: SessionSeq,
    agent: Agent,
    body: string,
    trigger: 'marker' | 'tool',
    sourceCommandId?: string,
  ): Promise<{ result: CompactionResult; archiveMs: number; txnMs: number }> {
    const archiveStartedAt = Date.now()
    await this.archiveBestEffort(trigger)
    const archiveMs = Date.now() - archiveStartedAt
    const blocks: ContentBlock[] = [{ type: 'text', text: body }]
    const txnStartedAt = Date.now()
    const result = await compactSurfaceRegion(
      {
        meter: this.ctx.tokenMeter,
        // 供给式摘要：不建 replay 载荷、不调 LLM——摘要就在手上
        summarize: () => Promise.resolve({
          summary: blocks,
          rawOutput: blocks,
          provider: agent.options.provider ?? '',
          model: agent.options.model ?? '',
        }),
      },
      session,
      start,
      end,
      agent,
      {
        owner: inspectCompactionEntryState(session as never).openTurn === null ? null : 'current-turn',
        stability: 'selected-span',
        ...(sourceCommandId === undefined ? {} : { sourceCommandId: sourceCommandId as never }),
        flush: async () => { await this.ctx.sessions.flush(session) },
      },
    )
    return { result, archiveMs, txnMs: Date.now() - txnStartedAt }
  }

  /** 压缩前存档（保命优先）：checkpoint 服务不可用或失败都不阻塞压缩。 */
  private async archiveBestEffort(trigger: string): Promise<void> {
    const checkpoint = this.ctx.get('checkpoint') as
      | { create(reason: string): Promise<unknown> }
      | undefined
    if (checkpoint === undefined) return
    try {
      await checkpoint.create('压缩前自动存档（' + trigger + '）')
    } catch (error: unknown) {
      // 存档是保命网不是前置条件：失败只记账，不拦压缩（压缩本身可重来）
      this.ctx.logger.warn('pre-compaction checkpoint failed: '
        + (error instanceof Error ? error.message : String(error)))
    }
  }

  /** 注入一条可见的失败告知（同 seq 只报一次；投递绝不反噬主流程）。 */
  private notifyOnce(session: SessionView, seq: number, text: string): void {
    const seen = reported.get(session as unknown as object) ?? new Set<number>()
    if (seen.has(seq)) return
    seen.add(seq)
    reported.set(session as unknown as object, seen)
    const agent = this.ctx.agents.get(session.id as never)
    if (agent === undefined) return
    try {
      agent.send(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'dsh-agent-compact' },
        }),
        'next-step',
        false,
      )
    } catch {
      // 告知是尽力而为：投递失败不得影响会话本身
    }
  }
}

// 构建自报（可维护性，2026-09-14）：进程加载即落一行轨迹，声明「我是哪个构建 +
// 我贡献什么 + 我依赖什么服务」。排障第一步历来是「线上跑的是哪个构建」。
trace({
  phase: 'boot',
  note: 'v' + VERSION + ' inject=agents,tokenMeter,sessions;path=marker-driven(agent output);auto=none',
})

export default AgentCompactEngine
