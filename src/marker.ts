/**
 * Marker-driven compaction decisions: which assistant message asks to compact,
 * whether that message may still do so, and which surface span it replaces.
 *
 * Everything here is pure or read-only so the three questions can be answered
 * offline in tests; the engine supplies only a session view and an agent.
 *
 * @module dsh-agent-compact/marker
 */

/** 视图：只要能按 seq 读事件（测试可喂数组，运行时喂 `session.eventAt`）。 */
export interface EventView {
  readonly seq: number
  eventAt(seq: number): { readonly type?: string; readonly data?: unknown } | undefined
}

/**
 * 助手消息里的**文本块**拼接（只取文本，工具调用参数永不进入判定）。
 *
 * 这一条本身就是护栏：我写文件、写技能、写语义文档时，内容都在工具调用参数里，
 * 不落文本块 ⇒ 文档里的规范块**不可能**触发压缩（2026-09-27 设计时识别的首要误触发面）。
 * @param content - `assistant/message.message.content`
 * @returns 文本块以换行拼接；无文本块时为空串
 */
export function assistantTextOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const typed = block as { type?: unknown; text?: unknown }
    if (typed.type !== 'text' || typeof typed.text !== 'string') continue
    parts.push(typed.text)
  }
  return parts.join('\n')
}

/** 回溯窗口：足够覆盖「一条消息 + 该消息之前的最近一次压缩」这一形状。 */
export const BOUNDARY_LOOKBACK = 400

/**
 * 最近一次 `compaction/end` 的 seq（有界回溯）。
 *
 * 用途是**幂等**：已经处理过的标记消息，其 seq 必然小于此后写入的 `compaction/end` seq
 * ⇒ 重启后重扫同一批事件也不会二次压缩。用事件流本身当状态，不额外落盘（§5.19 单点所有权）。
 * @param view - 会话事件视图
 * @param lookback - 最多向前回溯多少条
 * @returns `compaction/end` 的 seq；窗口内没有则 `undefined`
 */
export function latestCompactionEndSeq(
  view: EventView,
  lookback: number = BOUNDARY_LOOKBACK,
): number | undefined {
  const floor = Math.max(0, view.seq - lookback)
  for (let seq = view.seq - 1; seq >= floor; seq -= 1) {
    const event = view.eventAt(seq)
    if (event?.type === 'compaction/end') return seq
  }
  return undefined
}

/** 区间选择结论：可压（给出起止 seq）或不压（给出理由）。 */
export type MarkerSpan =
  | { readonly kind: 'span'; readonly start: number; readonly end: number }
  | { readonly kind: 'skip'; readonly reason: string }

/**
 * 选定「标记消息**之前**」的可压区间。
 *
 * 区间终点是标记消息的前一个表层节点——因此标记消息**不在**被替换的区间里：
 * 它可以带工具调用、可以带寒暄、可以带任务产出，都不会被吞掉，也不要求「独占一轮」。
 * 纪律靠人守会失败（2026-08-18 / 09-13 / 09-26 三次事故都是这么来的），机制必须对
 * 任意输出形态都正确。
 * @param surfaceNodes - 当前表层节点 seq（顺序即表层顺序）
 * @param markerSeq - 承载 checkpoint 块的那条助手消息的 seq
 * @param headSeq - 可压起点（system head 之后的首节点）
 * @returns 区间或跳过理由
 */
export function selectMarkerSpan(
  surfaceNodes: readonly number[],
  markerSeq: number,
  headSeq: number | undefined,
): MarkerSpan {
  if (headSeq === undefined) return { kind: 'skip', reason: 'surface 为空（没有可压区间）' }
  const markerIdx = surfaceNodes.indexOf(markerSeq)
  if (markerIdx === -1) return { kind: 'skip', reason: '标记消息不在表层（seq ' + String(markerSeq) + '）' }
  const headIdx = surfaceNodes.indexOf(headSeq)
  if (headIdx === -1) return { kind: 'skip', reason: '可压起点不在表层（seq ' + String(headSeq) + '）' }
  const endIdx = markerIdx - 1
  if (endIdx < headIdx) {
    return { kind: 'skip', reason: '标记消息之前没有可压内容（起点已在标记消息处）' }
  }
  return { kind: 'span', start: headSeq, end: surfaceNodes[endIdx]! }
}
