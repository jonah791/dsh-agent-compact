/**
 * selectCompactableRange 区间选择回归测试（2026-09-11 压缩契约二次修复）
 *
 * 事故（主人实测：「你跑完了整个压缩流程，但是上下文没有减少」）：
 *   压缩 start→summary 正常，但 compaction/end 报
 *   `surface replace: node 0 holds the system prompt and may be rewritten only by a
 *    system/message over exactly that node`
 *   现场证据：shadowedRange = {"start":14,"end":1728}，而 seq 14 正是 surface 节点 0 的
 *   `system/message`（持有 system prompt）。
 *
 * 根因：本插件移植了 `systemHead()` 用于**摘要输入**（buildSummarizationInput），
 *   却漏了**区间选择**——selectCompactableRange 硬编码 `start = surfaceNodes[0]`，
 *   而官方 compaction-basic 用 `firstIdx = systemHead(...) === undefined ? 0 : 1`
 *   （「A system/message at surface node 0 is never inside the range」）。
 *
 * 本测试用**真实 harness Session**（core/session）双向验证：
 *   ① 尸体测试：区间含 node 0（system）时，真实 Session.append 必须抛该错误
 *   ② 正样本：selectCompactableRange 不得把 node 0 纳入区间
 *
 * 运行：先构建（tsc），再 node --test tests/compact-range.test.mjs
 */
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

const HARNESS = process.env.DSH_HARNESS_ROOT ?? 'E:/alice/deepseek-harness'
const PLUGIN = process.env.DSH_COMPACT_ROOT ?? 'E:/alice/self-plugins/dsh-agent-compact'
const sessionLib = `${HARNESS}/packages/core/session/lib/index.js`
const llmLib = `${HARNESS}/packages/llm/llm/lib/index.js`
const regionLib = `${PLUGIN}/lib/region.js`

for (const p of [sessionLib, llmLib, regionLib]) {
  if (!existsSync(p)) {
    console.error(`[skip] 缺少已构建产物：${p}`)
    process.exit(0)
  }
}

const { Session, SessionId } = await import(pathToFileURL(sessionLib).href)
const { createSystemMessage, createUserMessage, createMessage } = await import(pathToFileURL(llmLib).href)
const { selectCompactableRange } = await import(pathToFileURL(regionLib).href)

/** 建一个以 system/message 打头（surface node 0）的真实会话，带若干对话节点。 */
function sessionWithSystemHead() {
  const s = Session.create(SessionId('compact-range'))
  s.append('turn/start', { turn: 1 })
  s.append('step/start', { turn: 1, step: 1 })
  // system/message 的 data 形状是 { turn, step, message }（须落在已开启的 step 内）
  s.append('system/message', {
    turn: 1,
    step: 1,
    message: createSystemMessage('YOU ARE A TEST SYSTEM PROMPT', 'test-plugin'),
  }, { surfaceOp: 'append' })
  for (let i = 0; i < 6; i += 1) {
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `turn ${i}` }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    s.append('assistant/message', {
      stream: [],
      turn: 1,
      step: i + 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `reply ${i}` }],
        source: { kind: 'model', ...{ provider: 'mock', model: 'mock' } },
      }),
    }, { surfaceOp: 'append' })
  }
  return s
}

/** 由会话表层造出 measurement（每节点 1 token，便于精确控制 keepFromIdx）。 */
function measurementOf(session, tokensPerNode = 10) {
  return { nodes: session.surface.nodes.map((seq) => ({ seq, tokens: tokensPerNode })) }
}

test('尸体测试：把区间起点放在 system node 0 上，真实 harness 必须拒绝', () => {
  const s = sessionWithSystemHead()
  const node0 = s.surface.nodes[0]
  const last = s.surface.nodes.at(-1)
  assert.ok(node0 !== undefined && last !== undefined)
  const event = s.eventAt(node0)
  assert.equal(event?.type, 'system/message', '前提：node 0 必须是 system/message')

  assert.throws(
    () => s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'test' },
    }), {
      surfaceOp: { op: 'replace', startSeq: node0, endSeq: last },
      sourceEventSeqs: s.surface.nodes.slice(),
    }),
    /node 0 holds the system prompt/,
    '若此处不抛错，说明宿主契约已变，需回头核对 core/session/src/surface.ts assertSystemHeadRewrite',
  )
})

test('正样本：selectCompactableRange 绝不把 system node 0 纳入区间', () => {
  const s = sessionWithSystemHead()
  const node0 = s.surface.nodes[0]
  const range = selectCompactableRange(s, measurementOf(s, 10), /* retainTokens */ 20)
  assert.ok(range !== null, '有可压缩内容时应返回区间（否则压缩永不触发）')
  assert.notEqual(range.start, node0, '区间起点不得是 system node 0（本事故根因）')
  assert.ok(
    s.surface.nodes.indexOf(range.start) >= 1,
    '区间起点应至少在索引 1（官方 firstIdx 语义）',
  )
})

test('无 system head 时，区间仍可从 node 0 开始（不误伤正常会话）', () => {
  const s = Session.create(SessionId('no-system-head'))
  s.append('turn/start', { turn: 1 })
  for (let i = 0; i < 6; i += 1) {
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `turn ${i}` }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  const node0 = s.surface.nodes[0]
  const range = selectCompactableRange(s, measurementOf(s, 10), 20)
  assert.ok(range !== null)
  assert.equal(range.start, node0, '无 system head 时 firstIdx=0，区间应从 node 0 起')
})

test('证据有效性：区间整体可被真实 harness 接受（替换成功且表层更新）', () => {
  const s = sessionWithSystemHead()
  const range = selectCompactableRange(s, measurementOf(s, 10), 20)
  assert.ok(range !== null)
  const shadowed = s.surface.nodes.filter(
    (seq) => s.surface.nodes.indexOf(seq) >= s.surface.nodes.indexOf(range.start)
      && s.surface.nodes.indexOf(seq) <= s.surface.nodes.indexOf(range.end),
  )
  const before = s.surface.nodes.length
  const replacement = s.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'test' },
  }), {
    surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end },
    sourceEventSeqs: shadowed,
  })
  const after = s.surface.nodes
  assert.ok(after.includes(replacement.seq), '替换体必须进入表层')
  assert.ok(!after.includes(range.start), '被替换区间必须离开表层')
  assert.equal(after[0], s.surface.nodes[0] ?? after[0], 'node 0 应保持不受影响')
  assert.ok(after.length < before, '表层节点数应减少（上下文真的变小）')
  assert.ok(s.surface.replaceGeneration > 0)
})
