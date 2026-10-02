/**
 * Checkpoint block recognition: the agent's own output IS the compaction
 * request. No instruction is ever delivered to the agent, so no surface
 * evidence, polling, or candidate guessing exists on this path.
 *
 * The recognizer is deliberately strict (sentinel line + fenced-off rule +
 * envelope tags + minimum size + the full ordered section set) because a false
 * positive silently rewrites conversation history.
 *
 * @module dsh-agent-compact/checkpoint-block
 */

/** 显式意图哨兵：必须独占一行且位于行首（防「文档/讨论里的模板」被误认）。 */
export const CHECKPOINT_SENTINEL = '<!-- alice-compact -->'

/** 块外壳（与既有 checkpoint 词汇一致，读侧工具无需改动）。 */
export const CHECKPOINT_OPEN_TAG = '<compacted-summary>'
export const CHECKPOINT_CLOSE_TAG = '</compacted-summary>'

/**
 * 规定的 section 标题，**按序**全部出现才算合法 checkpoint。
 *
 * 只查「在不在」会让半截模板（如我贴给主人看的三行示例）过关；查「按序全在」
 * 把误触发的形状从「像 checkpoint」收紧到「就是 checkpoint」。
 */
export const CHECKPOINT_SECTIONS: readonly string[] = [
  '## Primary Request and Intent',
  '## Key Technical Concepts',
  '## Files and Code',
  '## Errors and Fixes',
  '## Pending Jobs',
  '## Current Work',
  '## Next Step',
  '## Critical Context',
]

/** 识别结论：没这回事 / 有哨兵但不合法 / 合法且给出正文。 */
export type CheckpointBlock =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly reason: string; readonly chars: number }
  | { readonly kind: 'valid'; readonly body: string; readonly chars: number }

/**
 * 判断某个下标是否落在围栏代码块内（前面未闭合的 ``` 数量为奇数）。
 *
 * 为什么必须查：设计文档、技能、模板里都会**引用**完整规范形态。围栏是「这是引用」
 * 的唯一机器可读标记——不查它，一次文档展示就会把会话历史压掉。
 * @param text - 整段文本
 * @param index - 待判定位置
 * @returns 位于未闭合围栏内时为 `true`
 */
export function isInsideFence(text: string, index: number): boolean {
  const upto = text.slice(0, index)
  let fences = 0
  for (const line of upto.split('\n')) {
    if (/^\s*```/.test(line)) fences += 1
  }
  return fences % 2 === 1
}

/**
 * 近似诊断：把「正文里这些标题实际写成什么样」报出来。
 *
 * 存在理由（2026-10-02 事故）：6 笔被拒的块**正文长度正常**（3.7K–11.8K 字符），
 * 但 8 个 section 全数未命中——因为标题被加了编号前缀（`## 1 · Primary Request…`）
 * 或换了语种（`## 1. 当前任务与目标`）。原报错只列「缺哪八节」，读起来像
 * 「你根本没写标题」，真相只是一个前缀之差。让判据自己说出近似行，
 * 比让人回翻会话日志便宜。
 *
 * 只做**报告**，不改判据——命中与否仍以逐字匹配为准。
 * @param body - 外壳内的正文
 * @returns 至多 3 条近似命中说明
 */
function diagnoseMissingSections(body: string): string[] {
  const lines = body
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  const hints: string[] = []
  for (const section of CHECKPOINT_SECTIONS) {
    const core = section.replace(/^#+\s*/, '')
    const near = lines.find(line => line.includes(core) && !line.startsWith(section))
    if (near !== undefined) {
      const shown = near.length > 60 ? near.slice(0, 60) + '…' : near
      hints.push('实际写作「' + shown + '」（要求逐字：' + section + '）')
    }
  }
  return hints.slice(0, 3)
}

/**
 * 在一条助手消息的文本里识别 checkpoint 块。
 *
 * 判据（**全部**满足才算合法，任一不满足即 `invalid` 并附原因——「响」而不是沉默）：
 * 1. 恰有一行以哨兵开头（行首，允许前导空白）
 * 2. 该哨兵不在围栏代码块内
 * 3. 哨兵之后（可隔空行）紧跟 `<compacted-summary>`
 * 4. 存在配对的 `</compacted-summary>`
 * 5. 正文长度 ≥ `minChars`
 * 6. 正文按序含全部 {@link CHECKPOINT_SECTIONS}
 *
 * @param text - 助手消息的全部文本块（已拼接）
 * @param minChars - 正文长度下限（碎片拒收地板）
 * @returns 识别结论
 */
export function parseCheckpointBlock(text: string, minChars: number): CheckpointBlock {
  const lines = text.split('\n')
  const sentinels: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.trimStart().startsWith(CHECKPOINT_SENTINEL)) sentinels.push(index)
  }
  if (sentinels.length === 0) return { kind: 'absent' }
  // 多处哨兵 = 意图不明（是要压哪一块？）⇒ 宁可判不合法，绝不猜
  if (sentinels.length > 1) {
    return { kind: 'invalid', reason: '哨兵出现 ' + String(sentinels.length) + ' 次（必须恰好一次）', chars: 0 }
  }
  const sentinelLine = sentinels[0]!
  const sentinelOffset = text.split('\n').slice(0, sentinelLine).join('\n').length + (sentinelLine === 0 ? 0 : 1)
  if (isInsideFence(text, sentinelOffset)) {
    return { kind: 'invalid', reason: '哨兵位于围栏代码块内（视为引用，不是压缩意图）', chars: 0 }
  }

  let cursor = sentinelLine + 1
  while (cursor < lines.length && lines[cursor]!.trim() === '') cursor += 1
  if (cursor >= lines.length || lines[cursor]!.trim() !== CHECKPOINT_OPEN_TAG) {
    return { kind: 'invalid', reason: '哨兵后未紧跟 ' + CHECKPOINT_OPEN_TAG, chars: 0 }
  }

  const bodyLines: string[] = []
  let closed = false
  for (let index = cursor + 1; index < lines.length; index += 1) {
    if (lines[index]!.trim() === CHECKPOINT_CLOSE_TAG) {
      closed = true
      break
    }
    bodyLines.push(lines[index]!)
  }
  if (!closed) return { kind: 'invalid', reason: '缺少配对的 ' + CHECKPOINT_CLOSE_TAG, chars: 0 }

  const body = bodyLines.join('\n').trim()
  if (body.length < minChars) {
    return {
      kind: 'invalid',
      reason: '正文 ' + String(body.length) + ' 字符 < 下限 ' + String(minChars) + '（碎片拒收）',
      chars: body.length,
    }
  }

  const missing: string[] = []
  let scanFrom = 0
  for (const section of CHECKPOINT_SECTIONS) {
    const found = body.indexOf(section, scanFrom)
    if (found === -1) {
      missing.push(section)
      continue
    }
    scanFrom = found + section.length
  }
  if (missing.length > 0) {
    const hints = diagnoseMissingSections(body)
    const suffix = hints.length === 0 ? '' : ' —— 近似命中：' + hints.join('；')
    return {
      kind: 'invalid',
      reason: '缺少 section（按序查找未命中）：' + missing.join(' / ') + suffix,
      chars: body.length,
    }
  }

  return { kind: 'valid', body, chars: body.length }
}

/**
 * 规范块文本（供技能/文档/提示词引用，**不得**被当作意图）。
 *
 * 它刻意**不含**哨兵——引用者若原样粘贴，识别器只会看到外壳标签而判 `absent`
 * （没有哨兵就不是意图）；要真的压缩，必须显式补上哨兵那一行。
 * @param body - 摘要正文
 * @returns 带外壳的块文本
 */
export function formatCheckpointBlock(body: string): string {
  return CHECKPOINT_OPEN_TAG + '\n' + body.trim() + '\n' + CHECKPOINT_CLOSE_TAG
}

/**
 * 替换体前言：让接续的模型把 checkpoint 当作既成背景，而不是一段要回应的新指令。
 * （沿用官方 compaction 的词令，读侧与既有 checkpoint 节点保持同一形态。）
 */
export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * 把摘要包装成 checkpoint 节点的内容块（前言 + 外壳 + 正文）。
 *
 * 只保留文本块：非文本块（图像 / 推理）在被遮蔽内容里没有替代语义，混进替换体会
 * 让读侧看到一个「形状陌生」的 checkpoint。丢弃是显式的，不是静默 passthrough。
 * @param summary - 摘要内容块
 * @returns 替换体内容
 */
export function frameSummary(
  summary: readonly { readonly type?: string; readonly text?: string }[],
): { type: 'text'; text: string }[] {
  const text = summary
    .filter((block): block is { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string')
    .map(block => ({ type: 'text' as const, text: block.text }))
  return [
    { type: 'text', text: CHECKPOINT_PREAMBLE + '\n\n' + CHECKPOINT_OPEN_TAG },
    ...text,
    { type: 'text', text: CHECKPOINT_CLOSE_TAG },
  ]
}
