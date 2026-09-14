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

/**
 * 阶段枚举：一笔记账从 boot（进程级）到 captured / abort（事务级）。
 *
 * 两侧共同写同一个文件（2026-09-14 补 provider 侧）：
 *  - **provider 侧**（`dsh-compact-provider` 的 session_compact 工具）：
 *    `requested`（工具被调用，带 reason 摘要）→ `rejected`（前置判据不过，未触 seam）
 *    / `completed`（seam 返回）/ `failed`（seam 抛错）
 *  - **引擎侧**（AgentCompactEngine）：`begin` → `queued` → `waited` → `surfaced` → `captured`，失败写 `abort`
 * 两侧用 `side` 字段区分。**一条 `tail` 即可回答「谁发起 / 投给谁 / 断在哪一段 / 结果 / 耗时」。**
 */
export type TracePhase =
  | 'boot'
  | 'requested'
  | 'rejected'
  | 'completed'
  | 'failed'
  | 'begin'
  | 'queued'
  | 'waited'
  | 'surfaced'
  | 'captured'
  | 'abort'

/** 一行轨迹。字段全可选（除 atMs/phase/build），便于阶段增量补写。 */
export interface TraceEntry {
  /** 写入时刻（ms epoch）。 */
  atMs: number
  phase: TracePhase
  /** 构建标识 `<version>@<lib mtime ms>`——自证「线上跑的是哪个构建」。 */
  build: string
  /** 写者：`provider`（工具入口侧）/ `engine`（seam 侧）。缺省视为 engine（向后兼容旧行）。 */
  side?: 'provider' | 'engine'
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
  /** 已等待毫秒数（waited / abort）。 */
  waitedMs?: number
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
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    ...(entry.commandId !== undefined ? { commandId: entry.commandId } : {}),
    ...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
    ...(entry.ok !== undefined ? { ok: entry.ok } : {}),
    ...(entry.seqFloor !== undefined ? { seqFloor: entry.seqFloor } : {}),
    ...(entry.target !== undefined ? { target: entry.target } : {}),
    ...(entry.queueSeq !== undefined ? { queueSeq: entry.queueSeq } : {}),
    ...(entry.surfaceSeqs !== undefined ? { surfaceSeqs: entry.surfaceSeqs } : {}),
    ...(entry.waitedMs !== undefined ? { waitedMs: entry.waitedMs } : {}),
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

/** 构建标识：`<version>@<模块文件 mtime ms>`——版本号会说谎，mtime 不会。 */
export function buildStamp(moduleUrl: string, version?: string): string {
  let stamp = 'unknown'
  try {
    const file = fileURLToPath(moduleUrl)
    stamp = String(statSync(file).mtimeMs)
    const pkg = JSON.parse(readFileSync(join(dirname(file), '..', 'package.json'), 'utf8')) as { version?: string }
    if (typeof pkg.version === 'string' && pkg.version !== '') return `${pkg.version}@${stamp}`
  } catch {
    // 构建标识是尽力而为：拿不到也不得影响压缩主流程
  }
  return `unknown@${stamp}`
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
