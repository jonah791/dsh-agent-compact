/**
 * 属主回合时序回归测试（2026-09-23 事故守卫）
 *
 * 事故（外部维护会话定位，爱丽丝修数据）：`dsh-agent-compact` 的忙会话分支先 append
 * `compaction/start`（以**入口时**的 openTurn 当属主），再 `await` 一次 LLM 摘要
 * （实测可达 120s）；回合在这段 await 里结束，`summary`/`end` 就落进了**下一个回合**。
 * 0.1.7 的读侧（`session-format-v3-to-v4/src/relationships.ts:229-237 / 270-271`）把这条
 * 变成硬拒收：`turn/end crosses an open compaction` ⇒ **12 个会话打不开**。
 *
 * 修复语义：`start→summary→end` 必须在**同一 tick** 内连续落盘，属主回合 = **提交那一刻**
 * 开着的回合（空闲则为 null，读侧接受）。
 *
 * 本测试用**真实 harness Session** 跑**真实 region 事务**，把「摘要期间回合结束」这件事
 * 做进 summarize 回调里（模拟那 120s），再断言落盘的生命周期事件属于**新**回合：
 *   - 正样本：start.turn === 2 且 end.turn === 2
 *   - 尸体对照：若实现退回「入口时读 openTurn」，本测试必然红（turn === 1）
 *
 * 诚实边界：summarize 是桩（不打真实模型）；被验的是**时序与属主回合**，不是摘要质量。
 *
 * 运行：先构建（tsc），再 node --test tests/owner-turn.test.mjs
 */
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 路径解析：Windows 形态优先，缺失时回退 WSL 形态（`E:/x` → `/mnt/e/x`）。
 *
 * 为什么要有（2026-09-23 实测）：夹具原先硬编码 `E:/…`，在 WSL 里 `existsSync` 恒 false
 * ⇒ 测试走 `[skip]` 分支 `process.exit(0)`，而 `node --test` 把它记成 **pass** ⇒
 * **假绿**（断言从未执行，回归面看起来全绿）。夹具不得依赖运行平台。
 * @param winPath - Windows 形态的绝对路径。
 * @returns 本机真实存在的那个形态。
 */
function pickRoot(winPath) {
  if (existsSync(winPath)) return winPath
  return winPath.replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
}

const HARNESS = process.env.DSH_HARNESS_ROOT ?? pickRoot('E:/alice/deepseek-harness')
const PLUGIN = process.env.DSH_COMPACT_ROOT ?? pickRoot('E:/alice/self-plugins/dsh-agent-compact')
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
const { compactSurfaceRegion, selectCompactableRange } = await import(pathToFileURL(regionLib).href)

/** 建一个真实会话：system/message 打头 + 若干对话节点，**回合 1 保持开着**（自动压缩的前置）。 */
function openTurnSession() {
  const s = Session.create(SessionId('owner-turn'))
  s.append('turn/start', { turn: 1 })
  s.append('step/start', { turn: 1, step: 1 })
  s.append('system/message', {
    turn: 1,
    step: 1,
    message: createSystemMessage('YOU ARE A TEST SYSTEM PROMPT'),
  }, { surfaceOp: 'append' })
  for (let i = 0; i < 6; i += 1) {
    s.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `user turn ${i}` }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    s.append('assistant/message', {
      stream: [],
      turn: 1,
      step: i + 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `reply ${i}` }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
  }
  return s
}

/** 计量桩：每节点 100 token；摘要消息估 10 token（必须小于被遮蔽量，否则事务自身会拒）。 */
function meterStub(session) {
  return {
    measure: (s) => ({ nodes: s.surface.nodes.map((seq) => ({ seq, tokens: 100 })) }),
    estimateMessage: () => 10,
    session,
  }
}

/** 收集会话里全部 compaction 生命周期事件（按 seq 升序）。 */
function lifecycleOf(session) {
  const out = []
  for (let i = 0; i < session.seq; i += 1) {
    const event = session.eventAt(i)
    if (event === undefined) continue
    if (event.type === 'compaction/start' || event.type === 'compaction/summary' || event.type === 'compaction/end') {
      out.push({ seq: event.seq, type: event.type, turn: event.data?.turn })
    }
  }
  return out
}

test('属主回合：摘要期间回合结束 ⇒ start/summary/end 仍落在**提交那一刻**的回合（尸体守卫）', async () => {
  const session = openTurnSession()
  const meter = meterStub(session)
  const range = selectCompactableRange(session, meter.measure(session), 100)
  assert.ok(range !== null, '前提：本会话应有可压缩区间')

  let summaryRan = false
  const dependencies = {
    meter,
    summarize: async () => {
      // 模拟 LLM 摘要耗时（实测可达 120s）：期间本回合结束、新回合开始。
      // 这正是旧实现把 summary/end 落进下一回合的那段窗口。
      summaryRan = true
      session.append('turn/end', { turn: 1, reason: 'completed' })
      session.append('turn/start', { turn: 2 })
      return {
        summary: [{ type: 'text', text: 'CHECKPOINT BODY '.repeat(30) }],
        provider: 'mock',
        model: 'mock',
      }
    },
  }

  const result = await compactSurfaceRegion(
    dependencies,
    session,
    range.start,
    range.end,
    { id: 'agent-owner-turn', session },
    { owner: 'current-turn', stability: 'selected-span' },
  )
  assert.ok(result !== null && result !== undefined, '事务应成功返回结果')
  assert.equal(summaryRan, true, '前提：摘要确实跑过（否则本测试没有覆盖那个窗口）')

  const lifecycle = lifecycleOf(session)
  const start = lifecycle.find((e) => e.type === 'compaction/start')
  const summary = lifecycle.find((e) => e.type === 'compaction/summary')
  const end = lifecycle.find((e) => e.type === 'compaction/end')
  assert.ok(start !== undefined && summary !== undefined && end !== undefined,
    `生命周期三件套必须齐全，实得 ${JSON.stringify(lifecycle)}`)

  // 核心判据：属主回合 = 提交那一刻开着的回合（2），而不是入口时的回合（1）。
  assert.equal(start.turn, 2,
    'compaction/start 的属主回合必须是**提交那一刻**的 openTurn；'
    + '若为 1，说明退回「入口时读 openTurn」的旧写法（12 个会话被写坏的根因）')
  assert.equal(end.turn, 2, 'compaction/end 必须与 start 同属主回合')
  assert.ok(!lifecycle.some((e) => e.turn === 1),
    '生命周期事件不得出现回合 1（那意味着跨回合闭合）')

  // 三件套必须**连续相邻**（同一 tick 落盘）——读取器要求 summary/end 落在 start 的属主回合内，
  // 中间夹一个 turn/* 就会触发 `turn/end crosses an open compaction`。
  assert.deepEqual(
    lifecycle.map((e) => e.type),
    ['compaction/start', 'compaction/summary', 'compaction/end'],
    'start→summary→end 之间不得夹入任何 turn/* 事件',
  )
  assert.ok(summary.seq > start.seq && end.seq > summary.seq, 'seq 必须单调')
})

test('空闲会话：属主回合为 null（读侧接受，且不伪造回合号）', async () => {
  const session = Session.create(SessionId('idle-owner'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', {
    turn: 1, step: 1, message: createSystemMessage('SYS'),
  }, { surfaceOp: 'append' })
  for (let i = 0; i < 6; i += 1) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `u${i}` }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  // 关掉回合 ⇒ 空闲
  session.append('turn/end', { turn: 1, reason: 'completed' })

  const meter = meterStub(session)
  const range = selectCompactableRange(session, meter.measure(session), 100)
  assert.ok(range !== null)

  await compactSurfaceRegion(
    {
      meter,
      summarize: async () => ({
        summary: [{ type: 'text', text: 'IDLE CHECKPOINT '.repeat(30) }],
        provider: 'mock',
        model: 'mock',
      }),
    },
    session,
    range.start,
    range.end,
    { id: 'agent-idle', session },
    { owner: null, stability: 'selected-span' },
  )

  const start = lifecycleOf(session).find((e) => e.type === 'compaction/start')
  assert.ok(start !== undefined)
  assert.equal(start.turn, null, '空闲会话的属主回合必须是 null（不得沿用已结束的回合号）')
})
