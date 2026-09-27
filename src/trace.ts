/**
 * Durable delivery trace for the agent-driven compaction path.
 *
 * 动机（2026-09-14 可维护性事故复盘）：本插件只把过程写进 `ctx.logger`，而宿主
 * 组合的 logger 输出**不落盘**——于是「谁发的指令 / 投给谁 / 落地没 / 断在哪一段 /
 * 线上跑的是哪个构建」这些问题的唯一证据只剩会话事件流，需要外部现场写解析脚本
 * 才能反解。一次排障因此要写四段一次性代码。
 *
 * 修法：每次投递把自己的阶段**落成可查询的 JSONL 侧车**——
 * `<DSH_HOME>/compaction-trace.jsonl`（一行一个阶段，`atMs` 单调）。
 * 判据约定（与 AGENTS.md §5.21 规则 6 对齐）：投递有三个可辨阶段
 * `queued`（入队）→ `surfaced`（进表层，即模型可见）→ `captured`（捕获）；
 * 事务失败必写 `abort`（带 error 与已等毫秒数），**断点即最后一条非 abort 阶段**。
 *
 * 为什么是侧车而不是会话事件：本轨迹不是模型可见输入，是机制自证证据
 * （同 `dsh-agent-context` 的 `context-reminder-state.json`、`life-core/state.json`
 * 的既有约定——§5.12 规则 3「提醒类机制要有存活证据」）。
 *
 * @module dsh-agent-compact/trace
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from './version.ts'

/**
 * 阶段枚举：一笔记账从 boot（进程级）到 committed / abort（事务级）。
 *
 * 0.2.0（标记驱动）后的阶段词汇：
 *  - **引擎侧**：`detected`（识别到合法 checkpoint 块）→ `committed`（表层已换血）；
 *    `skipped`（是意图但没压：幂等 / 无可压区间 / 拿不到 agent）；
 *    `rejected`（**有哨兵但不合法**——写坏了，必须响亮）；`abort`（事务抛错）
 *  - **存档侧**（2026-09-27 新增，**非阻塞派发**）：`archive-dispatched`（已派发、立即返回）
 *    → `archive-settled`（落定，带 `durationMs` / `ok` / `error`）；`archive-skipped`
 *    （单飞命中：上一次未落定，或 checkpoint 服务不在本组合）。存档不再是提交路径的
 *    阶段——实测等它要 27 秒，而事务只 66 ms（见 `archive.ts`）。
 *  - **工具侧**（`dsh-compact-provider`）：`requested` → `completed` / `failed`
 * 两侧用 `side` 字段区分。**一条 `tail` 即可回答「谁发起 / 断在哪一段 / 结果 / 耗时」。**
 *
 * 历史词汇（`begin` / `queued` / `waited` / `surfaced` / `captured`）属 0.1.x 的投递链，
 * 已随该链路删除；旧轨迹行仍可能含它们（读侧按字符串处理，不受影响）。
 */
export type TracePhase =
  | 'boot'
  | 'requested'
  | 'rejected'
  | 'completed'
  | 'failed'
  | 'detected'
  | 'skipped'
  | 'committed'
  | 'abort'
  | 'archive-dispatched'
  | 'archive-settled'
  | 'archive-skipped'
  | 'begin'
  | 'queued'
  | 'waited'
  | 'surfaced'
  | 'captured'

/** 一行轨迹。字段全可选（除 atMs/phase/build），便于阶段增量补写。 */
export interface TraceEntry {
  /** 写入时刻（ms epoch）。 */
  atMs: number
  phase: TracePhase
  /** 构建标识 `<version>@<lib mtime ms>`——自证「线上跑的是哪个构建」。 */
  build: string
  /** 写者：`provider`（工具入口侧）/ `engine`（seam 侧）。缺省视为 engine（向后兼容旧行）。 */
  side?: 'provider' | 'engine'
  /**
   * 触发路径（2026-09-23 新增）：`step-pressure`（步间压力）/ `context-overflow`（请求溢出恢复）
   * / `manual-idle`（空闲会话手动）/ `manual-busy`（忙会话手动，fire-and-forget）。
   *
   * 为什么必须记：自动路径原先**零轨迹**，一旦写坏会话只能事后反解事件流去猜
   * 「谁写的 / 哪个构建写的 / 断在哪一阶段」——2026-09-23 修 12 个会话时正是这个处境。
   */
  trigger?: string
  /** provider：`session_compact` 的 reason 摘要（截断，仅决策留痕）。 */
  reason?: string
  /** provider：调用方声明的 commandId（如 `alice-self-compact`）。 */
  commandId?: string
  /** provider：目标 agent 标识摘要。 */
  agentId?: string
  /** provider：本笔是否成功（completed=true / rejected·failed=false）。 */
  ok?: boolean
  /** 注入前 seq 下界：与 `compaction/end.error` 里的 `after seq N` 同源，可 join 事件流。 */
  seqFloor?: number
  /** 投递目标（`next-turn` / `next-step`）。 */
  target?: string
  /** 入队事件 seq。 */
  queueSeq?: number
  /** 表层事件 seq 列表（`user/message`）。 */
  surfaceSeqs?: number[]
  /** 已等待毫秒数（历史字段：0.1.x 投递链的等待时长；标记路径不等任何人）。 */
  waitedMs?: number
  /**
   * 压缩前存档耗时 ms。
   *
   * **历史字段（2026-09-27 起不再写）**：存档已改为**非阻塞派发**（`archive.ts`），
   * 它不再是提交路径的一个阶段，故不再出现在 `committed` 行。留着类型与序列化只为
   * 向后兼容旧轨迹行（读侧按字符串处理，不受影响）。
   * ⚠ 别再往这里写「派发耗时」——那会是恒 0 的占位，与已废的 `waitedMs: 0` 同型
   * （看着像读数、实际是常量）。存档耗时归 `archive-settled` 行的 `durationMs`。
   */
  archiveMs?: number
  /** 存档耗时 ms（`archive-settled` 行）；在 `archive-skipped` 行表示「上一次已跑多久」。 */
  durationMs?: number
  /** 表层替换事务耗时 ms（含两次全表 token 计量）——`committed` 行的阶段分解之一。 */
  txnMs?: number
  /**
   * 本笔端到端耗时 ms（`detected` → `committed`）。
   *
   * 2026-09-27 线上首笔实测：`totalMs ≈ 21.9s`，而 `waitedMs` 恒 0——两者之间的
   * 差额原先无法归因（硬编码占位让侧车说不出话）。现按阶段分解，回答 §5.22 五问之⑤。
   */
  totalMs?: number
  /** 捕获到的 checkpoint 字符数（captured）。 */
  chars?: number
  /** 捕获文本是否含 `<compacted-summary>` 标记（captured）。 */
  markerOk?: boolean
  /** 会话 id 前缀（便于多会话并存时区分）。 */
  session?: string
  /** 自由附注（boot 自报用：入口/依赖声明）。 */
  note?: string
  /** 失败原因（abort）。 */
  error?: string
}

/** 解析 DSH_HOME：环境变量优先，缺省 `<homedir>/.dsh`（与既有插件同约定）。 */
export function resolveHome(
  env: Record<string, string | undefined> = process.env,
  fallback = homedir(),
): string {
  const raw = env['DSH_HOME']
  return raw !== undefined && raw.trim() !== '' ? raw : join(fallback, '.dsh')
}

/**
 * 会话标识摘要（8 位前缀）：轨迹里区分并存会话的最小字段。
 *
 * 单一真源（§5.22 规则 4）：原先只有 `summarizer.ts` 里有这份实现（module-private），
 * 自动路径要记同一字段时**只能复制**——复制品一旦漂移，两处的 `session` 就对不上、
 * 没法 join。故提到证据层并导出，两侧共用。
 *
 * ⚠ **2026-09-23 修正（原实现零区分力）**：真实会话 id 形如
 * `session-9919ca78-70a7-478a-84cb-…`，直接 `slice(0,8)` 得到的是**每个会话都一样的**
 * `session-`——字段在假装提供信息。改为剥掉通用前缀 `session-` 后再取 8 位（`9919ca78`）。
 * 兼容性：本日之前写入的轨迹行 `session` 恒为 `session-`（无信息量），读侧不必兼容。
 * @param session - 会话对象（形状宽松：只读可选 `id`）。
 * @returns 8 位标识；拿不到时 `undefined`（轨迹字段可缺，不得因它抛错）。
 */
export function sessionTagOf(session: unknown): string | undefined {
  const id = (session as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || id === '') return undefined
  const stripped = id.startsWith('session-') ? id.slice('session-'.length) : id
  return stripped === '' ? undefined : stripped.slice(0, 8)
}

/** 轨迹文件路径（纯函数，便于测试与文档化）。 */
export function compactionTracePath(home: string): string {
  return join(home, 'compaction-trace.jsonl')
}

/** 一行序列化：稳定键序 + 单行 JSON（便于 `tail`/`grep`）。 */
export function serializeTraceEntry(entry: TraceEntry): string {
  const ordered: TraceEntry = {
    atMs: entry.atMs,
    phase: entry.phase,
    build: entry.build,
    ...(entry.side !== undefined ? { side: entry.side } : {}),
    ...(entry.trigger !== undefined ? { trigger: entry.trigger } : {}),
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    ...(entry.commandId !== undefined ? { commandId: entry.commandId } : {}),
    ...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
    ...(entry.ok !== undefined ? { ok: entry.ok } : {}),
    ...(entry.seqFloor !== undefined ? { seqFloor: entry.seqFloor } : {}),
    ...(entry.target !== undefined ? { target: entry.target } : {}),
    ...(entry.queueSeq !== undefined ? { queueSeq: entry.queueSeq } : {}),
    ...(entry.surfaceSeqs !== undefined ? { surfaceSeqs: entry.surfaceSeqs } : {}),
    ...(entry.waitedMs !== undefined ? { waitedMs: entry.waitedMs } : {}),
    ...(entry.archiveMs !== undefined ? { archiveMs: entry.archiveMs } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    ...(entry.txnMs !== undefined ? { txnMs: entry.txnMs } : {}),
    ...(entry.totalMs !== undefined ? { totalMs: entry.totalMs } : {}),
    ...(entry.chars !== undefined ? { chars: entry.chars } : {}),
    ...(entry.markerOk !== undefined ? { markerOk: entry.markerOk } : {}),
    ...(entry.session !== undefined ? { session: entry.session } : {}),
    ...(entry.note !== undefined ? { note: entry.note } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
  }
  return JSON.stringify(ordered)
}

/** 容错解析：坏行跳过，不抛（轨迹是证据，不是契约校验器）。 */
export function parseTraceEntries(text: string): TraceEntry[] {
  const out: TraceEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as TraceEntry
      if (typeof parsed.atMs === 'number' && typeof parsed.phase === 'string') out.push(parsed)
    } catch {
      continue
    }
  }
  return out
}

/** 读轨迹文件；缺失/不可读返回空数组（诊断工具的安全入口）。 */
export function readTraceEntries(path: string): TraceEntry[] {
  try {
    return parseTraceEntries(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
}

/**
 * 构建标识：`<version>@<模块文件 mtime ms>`。
 *
 * ⚠ **2026-09-23 修正（版本号曾会说谎）**：原先版本号从模块旁的 `package.json` 读，
 * 而消费方以 `file:` 依赖安装时 pnpm 会**复制并重写** `package.json`（快照），
 * 只有 `lib/*.js` 是硬链接 ⇒ 实测同一个构建里「代码新、版本旧」（trace 里写着
 * `0.1.0@1790131527923`，而该 mtime 正是新产物的 mtime）。改读随源码走的
 * `VERSION` 常量（`src/version.ts`）——它与产物同为硬链接，副本里也是新值。
 *
 * `version` 显式传入时优先（测试与外部注入用）。
 * @param moduleUrl - 产物模块 URL（`import.meta.url`）。
 * @param version - 版本覆盖（缺省用 `VERSION`）。
 * @returns `<version>@<mtimeMs>`；取不到文件时 `unknown@unknown`（不抛）。
 */
export function buildStamp(moduleUrl: string, version?: string): string {
  try {
    const file = fileURLToPath(moduleUrl)
    return `${version ?? VERSION}@${String(statSync(file).mtimeMs)}`
  } catch {
    // 构建标识是尽力而为：拿不到也不得影响压缩主流程
    return 'unknown@unknown'
  }
}

/** 本次进程的构建标识（模块加载时算一次）。 */
export const BUILD = buildStamp(import.meta.url)

/** 追加一行（失败即吞：轨迹是观测，绝不能因写不进去而破坏压缩）。 */
export function appendTraceEntry(path: string, entry: TraceEntry): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, serializeTraceEntry(entry) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 记一笔轨迹：`trace({phase:'queued', target:'next-turn', …})`。 */
export function trace(entry: Omit<TraceEntry, 'atMs' | 'build'>, path?: string): boolean {
  return appendTraceEntry(
    path ?? compactionTracePath(resolveHome()),
    { atMs: Date.now(), build: BUILD, ...entry },
  )
}
