/**
 * checkpoint 块识别判据离线单测（标记驱动压缩 0.2.0 配套）
 *
 * 为什么判据必须严：识别成功 = **改写会话历史**。误判一次就把真实对话压掉；
 * 漏判只让本次压缩不发生（可重来）。⇒ 每一层护栏都要有**尸体样本**证明它会拦。
 *
 * 本文件按「护栏 → 尸体样本」组织：护栏一（哨兵行）、护栏二（围栏内视为引用）、
 * 护栏三（外壳配对）、护栏四（长度地板）、护栏五（section 按序全在）。
 *
 * 运行：npm test（先 build 再 node --test）
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHECKPOINT_SECTIONS,
  CHECKPOINT_SENTINEL,
  isInsideFence,
  parseCheckpointBlock,
  formatCheckpointBlock,
} from '../lib/checkpoint-block.js'

const MIN = 200

/** 规范正文：八个 section 各一行，凑够长度地板 */
const body = (extra = '') => CHECKPOINT_SECTIONS
  .map((section, index) => section + '\n- ' + '第' + String(index) + '节内容' + 'x'.repeat(20))
  .join('\n\n') + (extra === '' ? '' : '\n\n' + extra)

/** 规范块：哨兵 + 外壳 + 正文 */
const block = (text = body()) => CHECKPOINT_SENTINEL + '\n' + formatCheckpointBlock(text)

describe('parseCheckpointBlock · 正路径', () => {
  test('规范块 → valid，正文剥壳后原样返回', () => {
    const parsed = parseCheckpointBlock(block(), MIN)
    assert.equal(parsed.kind, 'valid')
    assert.equal(parsed.chars, parsed.body.length)
    assert.ok(parsed.body.startsWith(CHECKPOINT_SECTIONS[0]))
    assert.ok(!parsed.body.includes('<compacted-summary>'), '正文不得含外壳标签')
  })

  test('块不必独占消息（设计选择）：前后有寒暄/干活内容仍 valid', () => {
    const text = '先把这事收个尾。\n\n' + block() + '\n\n然后我继续做下一件事。'
    const parsed = parseCheckpointBlock(text, MIN)
    assert.equal(parsed.kind, 'valid')
  })

  test('哨兵前有前导空白仍识别（缩进不算篡改）', () => {
    const parsed = parseCheckpointBlock('  ' + block(), MIN)
    assert.equal(parsed.kind, 'valid')
  })

  test('哨兵与外壳之间空行不影响', () => {
    const text = CHECKPOINT_SENTINEL + '\n\n' + formatCheckpointBlock(body())
    assert.equal(parseCheckpointBlock(text, MIN).kind, 'valid')
  })
})

describe('护栏一 · 没有哨兵就不是意图（防文档/讨论误触发）', () => {
  test('尸体样本：只贴规范外壳（无哨兵）→ absent，绝不压缩', () => {
    const parsed = parseCheckpointBlock(formatCheckpointBlock(body()), MIN)
    assert.equal(parsed.kind, 'absent', '引用模板（无哨兵）必须被当作普通文本')
  })

  test('尸体样本：正文里顺口提到 <compacted-summary> 一词 → absent', () => {
    const parsed = parseCheckpointBlock('上一轮的 <compacted-summary> 块被替换掉了。', MIN)
    assert.equal(parsed.kind, 'absent')
  })

  test('formatCheckpointBlock 的产物本身不含哨兵（引用即安全）', () => {
    assert.ok(!formatCheckpointBlock(body()).includes(CHECKPOINT_SENTINEL))
  })

  test('多哨兵 = 意图不明 → invalid（不猜）', () => {
    const parsed = parseCheckpointBlock(block() + '\n\n' + block(), MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.match(parsed.reason, /哨兵出现 2 次/)
  })
})

describe('护栏二 · 围栏代码块内视为引用', () => {
  test('isInsideFence：奇数个围栏 = 在内', () => {
    const text = '前言\n```\n哨兵在这里\n```\n后记'
    assert.equal(isInsideFence(text, text.indexOf('哨兵')), true)
    const outside = '前言\n```\n代码\n```\n' + CHECKPOINT_SENTINEL
    assert.equal(isInsideFence(outside, outside.indexOf(CHECKPOINT_SENTINEL)), false)
  })

  test('尸体样本：把规范块贴进围栏里讲给别人听 → invalid 且不进压缩', () => {
    const text = '这是规范形态：\n\n```markdown\n' + block() + '\n```\n\n看懂了吗？'
    const parsed = parseCheckpointBlock(text, MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.match(parsed.reason, /围栏/)
  })
})

describe('护栏三/四 · 外壳配对与长度地板', () => {
  test('尸体样本：哨兵后没跟外壳 → invalid', () => {
    const parsed = parseCheckpointBlock(CHECKPOINT_SENTINEL + '\n刚才那段历史我压一下。', MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.match(parsed.reason, /未紧跟/)
  })

  test('尸体样本：缺闭合标签 → invalid（半截块绝不替换历史）', () => {
    const text = CHECKPOINT_SENTINEL + '\n<compacted-summary>\n' + body()
    const parsed = parseCheckpointBlock(text, MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.match(parsed.reason, /缺少配对/)
  })

  test('尸体样本：108 字符碎片（2026-09-26 真实事故形状）→ invalid', () => {
    const text = CHECKPOINT_SENTINEL + '\n<compacted-summary>\n好的，我现在压缩一下。\n</compacted-summary>'
    const parsed = parseCheckpointBlock(text, MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.match(parsed.reason, /碎片拒收/)
    assert.equal(parsed.chars, '好的，我现在压缩一下。'.length)
  })
})

describe('护栏五 · section 按序全在', () => {
  test('尸体样本：少一节 → invalid 并列出缺哪一节', () => {
    const partial = CHECKPOINT_SECTIONS.slice(0, -1).map(s => s + '\n- ' + 'x'.repeat(30)).join('\n\n')
    const parsed = parseCheckpointBlock(CHECKPOINT_SENTINEL + '\n' + formatCheckpointBlock(partial), MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.match(parsed.reason, /## Critical Context/)
  })

  test('尸体样本：八节都在但顺序错乱 → invalid（只查「在不在」会放过它）', () => {
    const shuffled = [...CHECKPOINT_SECTIONS].reverse().map(s => s + '\n- ' + 'x'.repeat(30)).join('\n\n')
    const parsed = parseCheckpointBlock(CHECKPOINT_SENTINEL + '\n' + formatCheckpointBlock(shuffled), MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.match(parsed.reason, /缺少 section/)
  })

  test('尸体样本：整段正文只有一节反复出现 → invalid', () => {
    const repeated = (CHECKPOINT_SECTIONS[0] + '\n- ' + 'x'.repeat(40) + '\n').repeat(8)
    const parsed = parseCheckpointBlock(CHECKPOINT_SENTINEL + '\n' + formatCheckpointBlock(repeated), MIN)
    assert.equal(parsed.kind, 'invalid')
  })

  test('尸体样本：标题带编号前缀（2026-10-02 真实事故形状）→ 报出近似行', () => {
    // 事故原貌：`## 1 · Primary Request and Intent`——正文长度正常，8 节却全数未命中。
    const numbered = CHECKPOINT_SECTIONS
      .map((section, index) =>
        '## ' + String(index + 1) + ' · ' + section.replace(/^#+\s*/, '') + '\n- ' + 'x'.repeat(30))
      .join('\n\n')
    const parsed = parseCheckpointBlock(CHECKPOINT_SENTINEL + '\n' + formatCheckpointBlock(numbered), MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.match(parsed.reason, /近似命中/, '必须给出近似诊断')
    assert.match(parsed.reason, /1 · Primary Request and Intent/, '要点明实际写法——否则读起来仍像「根本没写标题」')
  })

  test('对照组：真漏一节时不得报近似命中（证明该诊断有分辨力，不是恒亮）', () => {
    const partial = CHECKPOINT_SECTIONS
      .slice(0, -1)
      .map(section => section + '\n- ' + 'x'.repeat(30))
      .join('\n\n')
    const parsed = parseCheckpointBlock(CHECKPOINT_SENTINEL + '\n' + formatCheckpointBlock(partial), MIN)
    assert.equal(parsed.kind, 'invalid')
    assert.ok(
      !parsed.reason.includes('近似命中'),
      '缺失那节的正文里没有近似行，报了就是恒亮——恒亮的提示等于噪音',
    )
  })
})
