/**
 * 压缩前存档的**非阻塞派发**回归测试（2026-09-27 线上实测驱动）。
 *
 * 实测（第二笔线上压缩侧车）：`archiveMs = 27,270 ms`（占 99.8%），而事务只 **66 ms**。
 * 存档是 best-effort 却串在提交路径上 ⇒ 每次压缩白等二十多秒。修法 = **派发即返回**。
 *
 * 本组守四条不变量，其中两条是**尸体测试**（证明判据真的会拦）：
 *  ① 派发同步返回 `void`——**即使 create 永不 resolve**（尸体：等一个快的东西不算「不等」）
 *  ② create reject / 同步抛 ⇒ 只落 settled(ok:false) + warn，**绝不逃逸异常**（§5.24）
 *  ③ 单飞：上一次未落定时再派发 ⇒ `archive-skipped`（不并发压同一个 checkpoint 服务）
 *  ④ 落定后单飞释放 ⇒ 下一笔照常派发；settled 行带 `durationMs`（真读数，非恒 0 占位）
 *
 * 诚实边界：create 是桩，不打真实 checkpoint 服务；被验的是**派发语义**，
 * 不是「checkpoint 插件为何慢」——那个根因仍待查（见任务 t-899727c9）。
 *
 * 运行：先构建（tsc），再 node --test tests/archive.test.mjs
 */
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 路径解析：Windows 形态优先，缺失时回退 WSL 形态（`E:/x` → `/mnt/e/x`）。
 *
 * 夹具不得依赖运行平台（2026-09-23 实测：硬编码 `E:/…` 在 WSL 里恒 false ⇒ 走 skip
 * 分支 exit 0，而 `node --test` 记成 pass ⇒ **假绿**）。
 * @param winPath - Windows 形态的绝对路径。
 * @returns 本机真实存在的那个形态。
 */
function pickRoot(winPath) {
  if (existsSync(winPath)) return winPath
  return winPath.replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
}

const PLUGIN = process.env.DSH_COMPACT_ROOT ?? pickRoot('E:/alice/self-plugins/dsh-agent-compact')
const archiveLib = `${PLUGIN}/lib/archive.js`

if (!existsSync(archiveLib)) {
  console.error(`[skip] 缺少已构建产物：${archiveLib}`)
  process.exit(0)
}

const { createArchiveDispatcher, archiveReason } = await import(pathToFileURL(archiveLib).href)

/**
 * 测试台：注入 create 桩 + 轨迹/告警收集器 + 每次推进 100ms 的假时钟。
 * @param create - 存档入口桩。
 * @returns 派发器与两个收集器。
 */
function harness(create) {
  const entries = []
  const warns = []
  let clock = 1_000
  const dispatch = createArchiveDispatcher({
    create,
    trace: (entry) => entries.push(entry),
    warn: (message) => warns.push(message),
    now: () => {
      clock += 100
      return clock
    },
  })
  return { dispatch, entries, warns, phases: () => entries.map((e) => e.phase) }
}

/** 让 fire-and-forget 的 IIFE 跑到底（一轮宏任务足够：桩只有一次 await）。 */
function settle() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('① 尸体：create 永不 resolve ⇒ 派发仍同步返回 void，且已真的启动', async () => {
  let called = 0
  const t = harness(() => {
    called += 1
    return new Promise(() => {}) // 永远悬挂：模拟「存档卡住」
  })

  const returned = t.dispatch('marker')

  // 尸体判据：实现若写成 `async dispatch` 或内部 `await create`，这里拿到的是 Promise。
  assert.equal(returned, undefined,
    'dispatch 必须同步返回 void——返回 Promise 意味着调用方可能 await 它，病就还在')
  // 派发轨迹必须在**返回之前**已落（同步落证，不靠等）。
  assert.deepEqual(t.phases(), ['archive-dispatched'], '派发轨迹必须同步落盘')
  // fire-and-forget 必须真的启动：只记一行轨迹而没调 create 是假派发。
  assert.equal(called, 1, 'create 必须已被调用（不能只记账不干活）')

  await settle()
  assert.equal(t.warns.length, 0, '悬挂不是错误：不得误报 warn')
  assert.deepEqual(t.phases(), ['archive-dispatched'], '未落定就不得写 settled 行')
})

test('② reject ⇒ 落 settled(ok:false) + warn，异常不逃逸', async () => {
  const t = harness(() => Promise.reject(new Error('boom-reject')))

  assert.doesNotThrow(() => t.dispatch('marker'), '派发本身不得抛')
  await settle()

  assert.deepEqual(t.phases(), ['archive-dispatched', 'archive-settled'])
  assert.equal(t.entries[1].ok, false)
  assert.match(String(t.entries[1].error), /boom-reject/)
  assert.equal(t.warns.length, 1, '失败必须响（best-effort ≠ 静默）')
})

test('②b 同步抛 ⇒ 同样只落 settled，异常不逃逸（§5.24）', async () => {
  const t = harness(() => {
    throw new Error('boom-sync')
  })

  assert.doesNotThrow(() => t.dispatch('marker'), 'create 同步抛也不得从 dispatch 逃出')
  await settle()

  assert.deepEqual(t.phases(), ['archive-dispatched', 'archive-settled'])
  assert.equal(t.entries[1].ok, false)
  assert.match(String(t.entries[1].error), /boom-sync/)
  assert.equal(t.warns.length, 1)
})

test('③ 单飞：未落定时再派发 ⇒ archive-skipped（带连续计数与已跑时长）', async () => {
  let release
  const t = harness(() => new Promise((resolve) => { release = resolve }))

  t.dispatch('marker')
  t.dispatch('marker')
  t.dispatch('marker')

  assert.deepEqual(t.phases(), ['archive-dispatched', 'archive-skipped', 'archive-skipped'])
  assert.match(String(t.entries[1].note), /第 1 次连续跳过/)
  assert.match(String(t.entries[2].note), /第 2 次连续跳过/)
  assert.equal(typeof t.entries[2].durationMs, 'number',
    '跳过必须带「上一次已跑多久」——否则卡死无法从侧车看出来（§5.10 静默失败）')

  release()
  await settle()
  assert.deepEqual(t.phases(),
    ['archive-dispatched', 'archive-skipped', 'archive-skipped', 'archive-settled'],
    '落定后必须补上 settled 行')
})

test('④ 落定后单飞释放；settled 行带 durationMs（真读数）', async () => {
  const t = harness(() => Promise.resolve('ok'))

  t.dispatch('marker')
  await settle()
  t.dispatch('marker')
  await settle()

  assert.deepEqual(t.phases(),
    ['archive-dispatched', 'archive-settled', 'archive-dispatched', 'archive-settled'],
    '上一笔落定后，下一笔必须照常派发（单飞只防并发，不防后续）')

  const settled = t.entries.filter((e) => e.phase === 'archive-settled')
  assert.equal(settled.length, 2)
  for (const entry of settled) {
    assert.equal(entry.ok, true)
    assert.ok(entry.durationMs > 0,
      'durationMs 必须是真读数（注入时钟每次推进 100ms）——恒 0 就是下一个 waitedMs: 0')
  }
  assert.equal(t.warns.length, 0)
})

test('⑤ 原因文案与线上轨迹对齐（archiveReason 单一真源）', () => {
  assert.equal(archiveReason('marker'), '压缩前自动存档（marker）')
  assert.equal(archiveReason('tool'), '压缩前自动存档（tool）')

  const t = harness((reason) => {
    assert.equal(reason, '压缩前自动存档（marker）', 'create 必须收到同一份文案')
    return Promise.resolve()
  })
  t.dispatch('marker')
})
