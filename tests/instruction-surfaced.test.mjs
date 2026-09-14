/**
 * `instructionSurfaced` 的判据测试：**入队 ≠ 模型看见**。
 *
 * 现场样本（2026-09-13 事件流取证，session-879c4ae1）：
 *   · 健康压缩（turn 36/47）：queued=1（agent/inbox/spliced 带 inserted）+ drained=1
 *     + surfaced=1（user/message 携带指令）
 *   · 缺陷压缩（turn 29 / compaction 9ce76cec）：queued=1、drained=0、**surfaced=0**
 *     → 120s 超时后捕获到别的工作文本（117 字符）
 *
 * 运行：npm test（node --test tests/*.test.mjs）
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { instructionSurfaced, AGENT_COMPACTION_INSTRUCTION } from '../lib/summarizer.js'

/** 造一个最小会话语义视图：seq 从 0 起连续，事件按数组下标。 */
function viewOf(events) {
  return {
    seq: events.length,
    eventAt(index) { return events[index] },
  }
}

/**
 * 表层 user/message —— **实测形状**：`data.content: [{type:'text', text}]`。
 *
 * 这个 helper 曾经写成 `data.message.content`（我按记忆里的另一种写法写的），
 * 于是 `instructionSurfaced` 对真实事件恒返回 false → 0.1.2 上线后**第一次真实压缩
 * 被自己的闸门拦下**（compaction/end seq=7952，上下文卡在 512k）。
 * 现在两个形状都覆盖（见下面「形状覆盖」用例）。
 */
function surfacedMessage(text) {
  return { type: 'user/message', data: { content: [{ type: 'text', text }] } }
}

/** 另一种载体形状：`data.message.content`（兼容用例，不是实测主形状）。 */
function surfacedMessageNested(text) {
  return { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text }] } } }
}

/** 入队事件：inbox spliced 带 inserted（**不是**表层证据）。 */
function queuedInstruction() {
  return {
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', start: 0, inserted: [{ content: [{ type: 'text', text: AGENT_COMPACTION_INSTRUCTION }] }] },
  }
}

/** 排空事件：inbox spliced 带 removedCount（纯记账，也不是表层证据）。 */
function drainedInbox() {
  return { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } }
}

const INSTRUCTION_SEQ = 3

describe('instructionSurfaced：指令是否真的进了模型可见表层', () => {
  test('健康形态：入队 + 排空 + 表层出现 → surfaced=true 且给出 seq', () => {
    const view = viewOf([
      { type: 'compaction/start', data: {} },
      queuedInstruction(),
      drainedInbox(),
      surfacedMessage(AGENT_COMPACTION_INSTRUCTION + '\n\n更多说明'),
      { type: 'compaction/summary', data: {} },
    ])
    const result = instructionSurfaced(view, 0)
    assert.equal(result.surfaced, true)
    assert.deepEqual(result.seqs, [INSTRUCTION_SEQ])
  })

  test('现场坏样本（turn 29 形态）：只有入队与排空、无表层 → surfaced=false', () => {
    const view = viewOf([
      queuedInstruction(),
      drainedInbox(),
      { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '竞态窗口就在 compressUnit 里…' }] } } },
    ])
    const result = instructionSurfaced(view, 0)
    assert.equal(result.surfaced, false, '入队与排空都不是表层证据——这正是旧版脚本误报"双投递"的形状')
    assert.deepEqual(result.seqs, [])
  })

  test('seqFloor 之前的表层指令不算（那是上一次投递的残留）', () => {
    const view = viewOf([
      surfacedMessage(AGENT_COMPACTION_INSTRUCTION),
      { type: 'compaction/end', data: {} },
      { type: 'step/start', data: {} },
    ])
    assert.equal(instructionSurfaced(view, 1).surfaced, false)
    assert.equal(instructionSurfaced(view, 0).surfaced, true)
  })

  test('只认 user/message：assistant 复述指令不算表层证据', () => {
    const view = viewOf([
      { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: AGENT_COMPACTION_INSTRUCTION }] } } },
      { type: 'agent/inbox/spliced', data: { inserted: [{ content: [{ type: 'text', text: AGENT_COMPACTION_INSTRUCTION }] }] } },
    ])
    assert.equal(instructionSurfaced(view, 0).surfaced, false)
  })

  test('异形内容不崩：content 缺失 / 非数组 / 非文本块一律跳过', () => {
    const view = viewOf([
      { type: 'user/message', data: {} },
      { type: 'user/message', data: { message: { content: 'not-an-array' } } },
      { type: 'user/message', data: { message: { content: [{ type: 'image', attachment: 'x' }] } } },
      { type: 'user/message', data: { message: { content: [{ type: 'text' }, { type: 'text', text: 42 }] } } },
      surfacedMessage('普通消息，不含指令'),
    ])
    const result = instructionSurfaced(view, 0)
    assert.equal(result.surfaced, false)
  })

  test('多张表层出现（异常但可观测）：全部 seq 都报出来，交由调用方裁决', () => {
    const view = viewOf([
      surfacedMessage(AGENT_COMPACTION_INSTRUCTION),
      surfacedMessage('中间消息'),
      surfacedMessage(AGENT_COMPACTION_INSTRUCTION),
    ])
    const result = instructionSurfaced(view, 0)
    assert.equal(result.surfaced, true)
    assert.deepEqual(result.seqs, [0, 2])
  })

  test('形状覆盖：两种载体形状都要认（data.content 与 data.message.content）', () => {
    const flat = instructionSurfaced(viewOf([surfacedMessage(AGENT_COMPACTION_INSTRUCTION)]), 0)
    assert.equal(flat.surfaced, true, 'data.content 是实测主形状，必须被认出来')
    const nested = instructionSurfaced(viewOf([surfacedMessageNested(AGENT_COMPACTION_INSTRUCTION)]), 0)
    assert.equal(nested.surfaced, true, '另一种载体形状也要兼容')
  })

  test('回归样本（2026-09-14 事故）：摘要先于表层、表层在下个 turn 边界出现 → 仍须判 true', () => {
    // 真实序列：compaction/start(7940) → 入队(7941) → 摘要 assistant(7945) → turn/end(7947)
    // → turn/start(7948) → 排空(7949) → 表层 user/message(7951)
    const view = viewOf([
      { type: 'compaction/start', data: {} },
      queuedInstruction(),
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '## Primary Request and Intent' }] } } },
      { type: 'turn/end', data: {} },
      { type: 'turn/start', data: {} },
      drainedInbox(),
      surfacedMessage(AGENT_COMPACTION_INSTRUCTION),
      { type: 'compaction/summary', data: {} },
    ])
    const result = instructionSurfaced(view, 1)
    assert.equal(result.surfaced, true, '表层晚于摘要出现也必须算已投递（顺序不固定）')
    assert.deepEqual(result.seqs, [6])
  })
})
