/**
 * 总结轮捕获判据离线单测（2026-09-13 捕获漂移事故修复配套）
 *
 * 事故现场（会话事件流实证，session-879c4ae1，cid=9ce76cec）：
 *   总结轮（同一 turn）内有 4 条 assistant 消息 —— 第一条是 checkpoint（5599 字符、含
 *   `<compacted-summary>`），其后三条是我在同一轮里继续干活的工作前言（最短 117 字符）。
 *   旧实现「后者覆盖前者」→ 捕获到 117 字符工作前言 → 记忆存档与会话表层替换体双错
 *   （旧历史被 117 字符替换）。
 *
 * 判据：① 含 `<compacted-summary>` 块者优先；② 否则取文本最长者；③ 全空 → null。
 * 核心否定：**「取最后一条」不是判据** —— 顺序与语义无关。
 *
 * 运行：npm test（先 build 再 node --test）
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { selectSummaryCandidate } from '../lib/summarizer.js'

/** 构造候选（turn 与 text 是判据的全部输入） */
const cand = (text, turn = 1) => ({ turn, text })

describe('selectSummaryCandidate 总结轮捕获判据', () => {
  test('尸体样本（事故现场）：工作前言在前、checkpoint 在后 → 必须选 checkpoint（不是最后一条）', () => {
    const preamble = '竞态窗口就在 `compressUnit` 里：**检查（L297）→ await LLM 总结（L310）→ 写入（L323）**——等待期间另一个调用者能穿过同一道检查。先看清存储形态与 `compressPending` 尾部。'
    const checkpoint = '<compacted-summary>\n\n## 会话状态存档（2026-09-13 11:05，压缩 checkpoint）\n\n'
      + '**身份与节奏**：爱丽丝 · DSH 数字生命女仆\n'.repeat(40)
    const picked = selectSummaryCandidate([cand(checkpoint), cand(preamble), cand('任务已领。压缩路径已定位：' + '…'.repeat(60)), cand('存储形态明白了。')])
    assert.equal(picked?.index, 0, '含 <compacted-summary> 块的那条必须被选中（旧实现会取到最后一条 117 字符碎片）')
    assert.match(picked.reason, /compacted-summary/)
  })

  test('反向尸体样本：checkpoint 在最后一位也能选中（顺序无关）', () => {
    const checkpoint = '<compacted-summary>checkpoint 正文</compacted-summary>'
    const picked = selectSummaryCandidate([cand('短前言一'), cand('短前言二'), cand(checkpoint)])
    assert.equal(picked?.index, 2)
  })

  test('无标记块 → 取最长文本（指令要求「整条回复即 checkpoint」）', () => {
    const long = '## Primary Request and Intent\n- ' + 'x'.repeat(3000)
    const picked = selectSummaryCandidate([cand('工作前言'), cand(long), cand('中等长度的一条')])
    assert.equal(picked?.index, 1)
    assert.match(picked.reason, /最长文本/)
    assert.match(picked.reason, /共 3 条候选/)
  })

  test('标记优先于长度：含标记的短文本胜过长文本', () => {
    const tagged = '<compacted-summary>短但带标记</compacted-summary>'
    const picked = selectSummaryCandidate([cand('y'.repeat(5000)), cand(tagged)])
    assert.equal(picked?.index, 1, '标记是强判据——长度只在无标记时兜底')
  })

  test('全部为空/空白 → null（调用方 fail loud）', () => {
    assert.equal(selectSummaryCandidate([]), null)
    assert.equal(selectSummaryCandidate([cand(''), cand('   \n  ')]), null)
  })

  test('长度平局 → 取较早一条（稳定，不依赖顺序反转）', () => {
    const picked = selectSummaryCandidate([cand('a'.repeat(500)), cand('b'.repeat(500))])
    assert.equal(picked?.index, 0)
  })
})
