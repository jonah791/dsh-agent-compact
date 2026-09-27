/**
 * 压缩前存档的**非阻塞派发**（2026-09-27 线上实测驱动）。
 *
 * 实测（第二笔线上压缩的侧车）：`archiveMs = 27,270 ms`（占 99.8%），而事务本身只
 * **66 ms**。存档是 best-effort（失败只 warn、从不拦压缩），却**串在提交路径上**——
 * 于是每次压缩白等二十多秒。
 *
 * 已逐个排除：sha256（`node:crypto`，7 MB ≈ 30 ms）、压缩（`files/` 存**原样字节**）、
 * 体积（4 文件 7.26 MB）、`storages` 规模（474 文件 / 14 MB）、事件循环阻塞
 * （跨窗口 wall clock 46,580 ms = `sleep 40s` + WSL 冷启 6.5s，零额外延迟）。
 * ⇒ 「27 s + 不阻塞」= 它在 **await I/O**（嫌疑：逐文件 fsync / 目录遍历 / cleanup）。
 *
 * **修法：派发即返回。** 语义安全性的依据——存档内容是 `storages` + `AGENTS.md`，
 * 而压缩只改**会话事件流**，两者**无因果关系** ⇒ 并行不产生竞态。
 *
 * 三条纪律：
 *  1. **单飞**：上一次未落定时不再派发（不并发压同一个 checkpoint 服务）。跳过时带
 *     「已跑多久 + 第几次连续跳过」，于是**卡死可从侧车看出来**（§5.10 静默失败）。
 *  2. **绝不逃逸异常**：整条链包在 try/catch 里（§5.24：逃逸异常 = 宿主死因）。
 *  3. **必留证**：`archive-dispatched` / `archive-settled` / `archive-skipped` 三态
 *     各落一行轨迹（§5.22 规则 1），耗时由 settled 行的 `durationMs` 承载。
 *
 * @module dsh-agent-compact/archive
 */

/** 存档轨迹三态（`TraceEntry.phase` 的成员子集，见 `trace.ts`）。 */
export type ArchivePhase = 'archive-dispatched' | 'archive-settled' | 'archive-skipped'

/** 一行存档轨迹：不含 `atMs`/`build`（由 trace 层补）。 */
export interface ArchiveTraceEntry {
  phase: ArchivePhase
  /** 派发至今的毫秒数（settled 行 = 本次耗时；skipped 行 = 上一次已跑多久）。 */
  durationMs?: number
  /** settled：本次是否成功。 */
  ok?: boolean
  /** settled：失败原因（成功时缺省）。 */
  error?: string
  /** 自由附注（如连续跳过计数）。 */
  note?: string
}

/** 派发器依赖（全部注入，便于离线测）。 */
export interface ArchiveDispatcherDeps {
  /** 真正干活的存档入口（线上为 `checkpoint.create(reason)`）。 */
  create: (reason: string) => Promise<unknown>
  /** 落一行轨迹（实现方须自行吞错）。 */
  trace: (entry: ArchiveTraceEntry) => void
  /** 失败告警（实现方须自行吞错）。 */
  warn: (message: string) => void
  /** 时钟注入（测试用；缺省 `Date.now`）。 */
  now?: () => number
}

/** 存档原因文案（与线上轨迹里的 `reason` 一致，便于对齐 manifest）。 */
export function archiveReason(trigger: string): string {
  return '压缩前自动存档（' + trigger + '）'
}

/**
 * 造一个**非阻塞**存档派发器：调用即返回 `void`，存档在后台跑完并落轨迹。
 *
 * 为什么返回值必须是 `void` 而不是 `Promise`：只要它是 Promise，调用方（或未来的
 * 维护者）就可能 `await` 它——那正是本次要根除的病。签名本身就是第一道护栏。
 *
 * @param deps - 存档入口、轨迹、告警与时钟
 * @returns 派发函数 `(trigger) => void`
 */
export function createArchiveDispatcher(deps: ArchiveDispatcherDeps): (trigger: string) => void {
  const now = deps.now ?? Date.now
  let inFlight = false
  let dispatchedAt = 0
  let consecutiveSkips = 0

  /** 观测绝不反噬主流程（§5.22 规则 3）：轨迹/告警自身抛错也不得影响压缩。 */
  const safe = (act: () => void): void => {
    try {
      act()
    } catch {
      // 观测是尽力而为：写不进去不改变压缩的结果
    }
  }

  return (trigger: string): void => {
    if (inFlight) {
      consecutiveSkips += 1
      safe(() => {
        deps.trace({
          phase: 'archive-skipped',
          durationMs: now() - dispatchedAt,
          note: '上一次存档未落定（第 ' + String(consecutiveSkips) + ' 次连续跳过）',
        })
      })
      return
    }

    inFlight = true
    consecutiveSkips = 0
    dispatchedAt = now()
    safe(() => {
      deps.trace({ phase: 'archive-dispatched' })
    })

    void (async (): Promise<void> => {
      let ok = false
      let error: string | undefined
      try {
        await deps.create(archiveReason(trigger))
        ok = true
      } catch (caught: unknown) {
        error = caught instanceof Error ? caught.message : String(caught)
      } finally {
        // 先释放单飞再落轨迹：下一笔压缩不必等这次记账写完
        inFlight = false
        safe(() => {
          deps.trace({
            phase: 'archive-settled',
            ok,
            durationMs: now() - dispatchedAt,
            ...(error === undefined ? {} : { error }),
          })
        })
        if (!ok) {
          safe(() => {
            deps.warn('pre-compaction checkpoint failed: ' + String(error))
          })
        }
      }
    })()
  }
}
