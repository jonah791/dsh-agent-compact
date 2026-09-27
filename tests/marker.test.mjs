/**
 * marker.ts 判据离线单测（标记驱动压缩 0.2.0 配套）
 *
 * 两个判据在这里被钉住：
 * ① **区间终点 = 标记消息的前一个表层节点** —— 标记消息本身不在被替换范围内。
 *    这是设计选择的承重点：它让「标记消息可以带工具调用、带寒暄、带任务产出」
 *    成为**机制保证**，而不是靠 agent 自觉遵守「独占一轮」的纪律（纪律靠人守会失败：
 *    2026-08-18 / 09-13 / 09-26 三次事故都是这么来的）。
 * ② **幂等靠事件流本身**：已处理过的标记消息，其 seq 必然小于此后写入的 compaction/end seq。
 *
 * 运行：npm test（先 build 再 node --test）
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { assistantTextOf, latestCompactionEndSeq, selectMarkerSpan } from '../lib/marker.js'

/** 造一个按 seq 取事件的视图（事件数组下标即 seq） */
const view = events => ({ seq: events.length, eventAt: seq => events[seq] })

describe('assistantTextOf · 只取文本块', () => {
  test('拼接全部文本块', () => {
    assert.equal(
      assistantTextOf([{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }]),
      '甲\n乙',
    )
  })

  test('尸体样本（首要误触发面）：工具调用参数不进入判定', () => {
    const content = [
      { type: 'text', text: '我来写文档。' },
      { type: 'tool_call', name: 'write', arguments: { content: '<!-- alice-compact -->\n<compacted-summary>…' } },
    ]
    const text = assistantTextOf(content)
    assert.ok(!text.includes('<!-- alice-compact -->'), '写文件时块在工具参数里，绝不落进判定文本')
  })

  test('退化输入不抛：非数组 / null 块 / 缺 text / 非文本类型', () => {
    assert.equal(assistantTextOf(undefined), '')
    assert.equal(assistantTextOf('字符串'), '')
    assert.equal(assistantTextOf([null, 42, {}, { type: 'reasoning', text: 'x' }]), '')
    assert.equal(assistantTextOf([{ type: 'text', text: 42 }]), '')
  })
})

describe('selectMarkerSpan · 区间终点是标记消息之前', () => {
  // 表层：system(0) 用户(1) 助手(2) 工具结果(3) 用户(4) 标记消息(5)
  const surface = [0, 1, 2, 3, 4, 5]

  test('区间 = [可压起点, 标记消息前一个节点]，标记消息不在区间里', () => {
    assert.deepEqual(selectMarkerSpan(surface, 5, 1), { kind: 'span', start: 1, end: 4 })
  })

  test('标记消息带工具调用/寒暄也一样（区间不含它 ⇒ 不会被吞）', () => {
    // 判据只依赖位置，不依赖标记消息的内容形态——这正是「机制保证」的含义
    assert.deepEqual(selectMarkerSpan(surface, 5, 1), { kind: 'span', start: 1, end: 4 })
  })

  test('没有 system head 时起点是 node 0', () => {
    assert.deepEqual(selectMarkerSpan(surface, 5, 0), { kind: 'span', start: 0, end: 4 })
  })

  test('尸体样本：标记消息紧邻起点 → 无可压内容（不压空区间）', () => {
    const span = selectMarkerSpan([0, 1], 1, 1)
    assert.equal(span.kind, 'skip')
    assert.match(span.reason, /没有可压内容/)
  })

  test('尸体样本：标记消息不在表层（未落地/已换血）→ 跳过并说明', () => {
    const span = selectMarkerSpan(surface, 99, 1)
    assert.equal(span.kind, 'skip')
    assert.match(span.reason, /不在表层/)
  })

  test('尸体样本：可压起点不在表层 → 跳过（不猜起点）', () => {
    const span = selectMarkerSpan(surface, 5, 42)
    assert.equal(span.kind, 'skip')
    assert.match(span.reason, /可压起点不在表层/)
  })

  test('尸体样本：空表层 → 跳过', () => {
    assert.equal(selectMarkerSpan([], 5, undefined).kind, 'skip')
  })
})

describe('latestCompactionEndSeq · 幂等的持久判据', () => {
  test('取最近一次 compaction/end 的 seq', () => {
    const v = view([
      { type: 'compaction/end' },
      { type: 'assistant/message' },
      { type: 'compaction/start' },
      { type: 'compaction/end' },
      { type: 'assistant/message' },
    ])
    assert.equal(latestCompactionEndSeq(v), 3)
  })

  test('窗口内没有 compaction/end → undefined（当作「没压过」）', () => {
    assert.equal(latestCompactionEndSeq(view([{ type: 'assistant/message' }])), undefined)
  })

  test('有界回溯：窗口外的 compaction/end 不参与判定（长会话不做 O(n) 重扫）', () => {
    const events = [{ type: 'compaction/end' }, ...Array.from({ length: 500 }, () => ({ type: 'assistant/message' }))]
    assert.equal(latestCompactionEndSeq(view(events), 400), undefined)
  })

  test('幂等语义：处理后 markerSeq < endSeq ⇒ 重启重扫也不会二次压缩', () => {
    const v = view([
      { type: 'assistant/message' },   // seq 0 = 标记消息
      { type: 'compaction/summary' },  // seq 1
      { type: 'compaction/end' },      // seq 2
    ])
    const boundary = latestCompactionEndSeq(v)
    assert.equal(boundary, 2)
    assert.ok(0 < boundary, '标记消息 seq 小于此后写入的 compaction/end ⇒ 判定为已处理')
  })
})
