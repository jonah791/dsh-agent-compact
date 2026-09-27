# 语义文档：标记驱动压缩引擎（Marker-Driven Compaction Engine）

> 版本 v0.2.1 · 2026-09-27 · 作者：爱丽丝 · 状态：**已实现（A1–A14 全部线上/离线已实测）**
> 主人指令：「重新设计压缩插件，围绕智能体自主压缩」（2026-09-27）
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-agent-compact/src/{index,checkpoint-block,marker,region,config,trace}.ts`
> ⚠ 0.1.x 的投递链设计（`agentSummarize` / 指令投递 / 表层取证 / 候选捕获）已**整体删除**；
> 其完整文档与事故史见本文件 git 历史（`git log -p -- docs/semantic.md`）。本文只描述 0.2.x
> 的现状与继承下来的判据。
> ✅ 线上首笔（2026-09-27 11:26，本会话）已实测通过：`detected → committed`、上下文
> 344,734 → 86,905 tok、标记消息与事务之间零额外请求（§9 有完整读数）。
> ✅ 失败路径同日实测（A12 尸体探针）：短块 → 侧车 `rejected` + **同回合下一个 step** 的可见告知。

---

## 1 · 定位与反定位

**定位**：把「压缩」实现为**智能体输出的一部分**。agent 在自己任意一轮的回复里写一个
**合法 checkpoint 块**；引擎旁路观察会话事件流，看到它就把**该消息之前**的历史替换成这份摘要。
摘要不需要被「要求」——它本来就是 agent 的下一段输出。

**一句话判据**：**压缩 = agent 说压就压；引擎是被动的手，不是发令的人。**

**反定位（本文不管什么）**：
- 不管「何时该压」的判断——那是 agent 的自主决策（提醒信号来自 `dsh-agent-context`，
  采用与否归 agent）
- 不管「agent 怎么想起来要压」——开启一轮的原语（自我感知圈 / 任务板 / 主人消息）不属于本插件
- **不是自动压缩**：`compactIfNeeded` 恒返回 `null`，引擎不注册任何 pressure / overflow 监听。
  主人 2026-08-16 定调「不要开自动压缩，别让框架强制影响你的决策」（AGENTS.md §2.4）
- **不是投递式压缩**：不存在「引擎要 agent 去总结」这条路径

**与 0.1.x 的关系**：不是改进，是**删除**。0.1.x 的四段链——① 引擎 `agent.send` 投递总结指令
② 等总结轮收口 ③ 表层取证「指令真的被模型看见」④ 在候选里按标记/长度猜哪条是 checkpoint——
**全部不复存在**。三次历史事故（入队未进表层 / 指令被重试吃掉 / 重启后孤儿 checkpoint）都长在
这条链上；它们不是被修好，是被删掉。

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| **checkpoint 块** | agent 输出里的一段结构化摘要：哨兵行 + `<compacted-summary>` 外壳 + 8 个 section 正文 |
| **哨兵** | `<!-- alice-compact -->`——**显式压缩意图**的唯一标记。没有它就不是意图（`absent`） |
| **标记消息** | 承载 checkpoint 块的那条 `assistant/message` |
| **可压区间** | `[可压起点, 标记消息的前一个表层节点]`——**标记消息不在区间内** |
| **可压起点** | surface 首个可压节点（node 0 若持 system prompt 则从 node 1 起，与官方同款） |
| **替换体** | 合成的 `compactCheckpointSource` 用户消息（前言 + 外壳 + 摘要正文） |
| **保命存档** | 提交前 best-effort 调 `checkpoint.create`（失败只 warn，不拦压缩） |
| **供给式摘要** | 摘要由调用方给出（agent 自己的输出或工具参数），引擎不调 LLM、不建 replay 载荷 |

## 3 · 概念模型

```
标记路径（主路径，零额外请求）
  agent 在任意一轮输出里写 checkpoint 块
     └─ ctx.on('session/event', 'assistant/message')
          ├─ 快筛：文本块不含哨兵 → 返回（绝大多数消息到此为止）
          ├─ parseCheckpointBlock（纯函数，五层护栏）
          │    absent  → 返回（不是意图）
          │    invalid → 侧车 rejected + 注入可见告知（**写坏了必须响**）
          │    valid   → setImmediate（避开 append 内 reenter）
          └─ handleMarker
               ├─ 幂等：markerSeq < 最近一次 compaction/end seq → skipped
               ├─ 属主：ctx.agents.get(session.id) 拿不到 → skipped（不猜）
               ├─ 区间：selectMarkerSpan(surface, markerSeq, headSeq)
               └─ commit：保命存档 → compactSurfaceRegion（供给式摘要）→ flush

工具路径（显式入口，同一个事务）
  session_compact({summary, reason}) → engine.compactWithSummary(agent, summary)
```

不变量（invariants）：
1. **I1 无哨兵不压缩**：没有哨兵一律 `absent`——文档、讨论、模板引用永不触发
2. **I2 标记消息不被吞**：区间终点是标记消息**之前**的节点 ⇒ 它可以带工具调用、带寒暄、
   带任务产出而不丢内容（**机制保证，不靠纪律**）
3. **I3 幂等靠事件流**：已处理的标记消息 seq 必然小于此后写入的 `compaction/end` seq ⇒
   重启重扫不会二次压缩（不额外落盘状态）
4. **I4 一次事务一条摘要**：本引擎不存在第二条 summarize 路径（投递链已删）
5. **I5 换血 op 恰好三键**：`{op,startSeq,endSeq}`（沿用，宿主 append 处 fail-loud）
6. **I6 属主回合 = 提交那一刻的 openTurn**：`start→summary→end` 同一 tick 连续落盘，
   满足 0.1.7 读侧硬判据（`compaction/start` 的 turn 必须等于当时开着的回合）
7. **I7 无自动路径**：`compactIfNeeded` 恒 `null`；`compactNow` / `compactRegion` 明确抛错
8. **I8 失败必响**：非法块与事务失败都落侧车轨迹 + 注入一条可见告知（`next-step`，不唤醒）
9. **I9 观测绝不反噬**：轨迹/告知一律吞错返回，绝不破坏压缩或会话主流程

## 4 · 契约

### 4.1 配置（`CompactConfig`，`src/config.ts`）
- `enabled`（默认 `true`）：是否启用标记路径
- `minCheckpointChars`（默认 `200`）：合法正文长度地板
- **旧策略字段全部删除**：`auto` / `thresholdRatio` / `retainRatio` / `retainTokens` /
  `modelPolicies` / `summarizationProvider` / `summarizationModel` / `maxTokens` /
  `compactionRetries` / `maxOverflowRetries`。⚠ 组合里若残留旧键会**装载失败**（fail loud）

### 4.2 checkpoint 块的合法形态（五层护栏，全部满足）
```markdown
<!-- alice-compact -->
<compacted-summary>
## Primary Request and Intent
- …
## Key Technical Concepts
- …
## Files and Code
- …
## Errors and Fixes
- …
## Pending Jobs
- …
## Current Work
- …
## Next Step
- …
## Critical Context
- …
</compacted-summary>
```
| # | 护栏 | 拦住的形状 |
|---|------|-----------|
| 1 | 恰有一行以哨兵开头（行首，允许前导空白） | 无哨兵（引用模板）/ 多哨兵（意图不明） |
| 2 | 哨兵不在围栏代码块内 | 「贴一段规范形态讲给人听」 |
| 3 | 哨兵后紧跟 `<compacted-summary>`，且有配对闭标签 | 半截块 |
| 4 | 正文 ≥ `minCheckpointChars` | 108 字符碎片（2026-09-26 真实事故形状） |
| 5 | 正文**按序**含全部 8 个 section | 少节 / 乱序 / 单节复读 |

**首要误触发面已被结构性排除**：识别只读助手消息的**文本块**，工具调用参数永不进入判定 ⇒
写文件、写技能、写语义文档（含 `formatCheckpointBlock()` 产物）**不可能**触发压缩。

### 4.3 事件序列（事务的持久形状，与官方字节兼容）
`compaction/start{turn}` → `compaction/summary{summary, rawOutput, shadowedRange, shadowedSeqs,
shadowedTokenCount, provider, model}` → `user/message{surfaceOp:{op,startSeq,endSeq}}` →
`compaction/end`。失败发生在 start 之前 ⇒ **不写任何事件**（绝不留下未闭合的 start）。

### 4.4 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| 宿主事件 | `src/index.ts:registerMarkerPath` → `ctx.on('session/event')` | 每条 `assistant/message` 落盘后 |
| 工具面 | `dsh-compact-provider:src/index.ts` → `engine.compactWithSummary` | `session_compact` 被调用 |
| 引擎自身 | `src/index.ts:commit` → `compactSurfaceRegion` | 两条入口共用的唯一事务 |
| 宿主 seam | `src/index.ts:compactIfNeeded` | 恒 `null`（无自动路径）；`compactNow`/`compactRegion` 恒抛 |

### 4.5 侧车轨迹 `[MUST]`（`<DSH_HOME>/compaction-trace.jsonl`）

| `side` | 阶段 | 含义 |
|--------|------|------|
| 缺省（引擎） | `boot` | 进程加载自报：版本 + inject + 路径 + `auto=none` |
| 缺省 | `detected` | 识别到合法块（带 `seqFloor` / `chars` / `agentId`） |
| 缺省 | `committed` | 表层已换血（`note` 含遮蔽节点数与 seq 区间；`txnMs`/`totalMs` 给耗时） |
| 缺省 | `skipped` | 是意图但没压（幂等 / 无可压区间 / 拿不到 agent），`note` 给理由 |
| 缺省 | `rejected` | **有哨兵但不合法**——写坏了（`error` 给具体护栏） |
| 缺省 | `abort` | 事务抛错（`error` 给原因） |
| 缺省 | `archive-dispatched` | 压缩前存档**已派发**（非阻塞、立即返回；`src/archive.ts`） |
| 缺省 | `archive-settled` | 存档落定：`ok` / `durationMs`（真耗时）/ 失败时 `error` |
| 缺省 | `archive-skipped` | 单飞命中（上一次未落定，`note` 带连续计数）或 checkpoint 服务不在本组合 |
| `provider` | `requested`/`rejected`/`completed`/`failed` | 工具入口侧四阶段 |

**断点即最后一条非终态阶段**。`build` 字段自证「线上跑的是哪个构建」（版本段取自随源码走的
`VERSION` 常量，不信消费方副本的陈旧 `package.json`）。

**耗时字段（0.2.1 补 → 0.3.0 定形）**：`committed` 行写 `txnMs`（表层替换事务，含 `region.ts`
对整张表层做的**两次** `meter.measure`）与 `totalMs`（`detected`→`committed` 端到端）。
**存档的耗时不在这一行**——它归 `archive-settled` 行的 `durationMs`。

这条字段演化史本身就是一条纪律：0.2.0 只写**硬编码**的 `waitedMs: 0`（看着像读数、实际是常量，
于是「21.9 秒花在哪」永远答不出来）；0.2.1 补 `archiveMs` 后，第二笔实测立刻显示
`archiveMs = 27,270 ms`（99.8%）而 `txnMs` 只 66 ms——**那个 27 秒就是存档**，此前「两次全表
计量」的猜测被证伪；0.3.0 遂把存档改为**非阻塞派发**，`archiveMs` 随之降为历史字段（留着类型与
序列化仅为兼容旧行）。⇒ **凡「恒为常量」或「已不在路径上」的字段都必须退场**，否则侧车会持续
说谎（§5.22 五问之⑤）。

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：本引擎不判断「该不该压」，也不拦恶意调用（调用方是自有插件）
- **哨兵的信任语义**：能写进 agent 输出 = 能压缩。这是**设计意图**（agent 是唯一决策者），
  不是漏洞；但因此**识别必须严**——误判一次就改写历史（见 §7 的尸体样本）
- 不越界清单：不改写 system 节点（`compactableHeadSeq` 从 node 1 起）；不删除事件（只做表层替换）；
  不在无哨兵时自行触发；不调 LLM（供给式摘要）
- 失败面：① 拿不到 agent → `skipped` ② 无可压区间 → `skipped` ③ 非法块 → `rejected` + 告知
  ④ 事务抛错 → `abort` + 告知 ⑤ 摘要不小于被遮蔽内容 → 事务内 fail loud（不替换）——
  **五处都不静默**

## 6 · 与既有机制的关系

- AGENTS.md **§2.4 / §2.1**（禁止框架自动压缩 / 决策归爱丽丝）：本引擎**结构上**没有自动路径
- AGENTS.md **§5.21**（压缩 checkpoint 纪律）：checkpoint 块的写法与「压缩后查存档」仍适用；
  「独占一轮」不再是机制要求（I2 让它变成可选），但仍是**推荐**（可读性）
- AGENTS.md **§5.22**（可维护性五问）：轨迹侧车一次 tail 答齐
- 与 `dsh-compact-provider` 的分工：provider 管**挂载与工具入口**，引擎管**识别与事务**
- 与 `dsh-agent-context` 的关系：它读 `compaction/end.error` 做失败守望——本引擎照旧写该字段

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据 | 状态 |
|---|-----------|------|------|
| A1 | 无哨兵的规范外壳 → `absent`，绝不压缩 | 单测 `checkpoint-block.test.mjs`（尸体样本） | 已实测 |
| A2 | 围栏内的哨兵 → `invalid`（引用不是意图） | 同上 | 已实测 |
| A3 | 少一节 / 乱序 → `invalid` 并列出缺哪节 | 同上 | 已实测 |
| A4 | 108 字符碎片 → `invalid`（碎片拒收） | 同上（2026-09-26 事故形状复刻） | 已实测 |
| A5 | 工具调用参数里的块**不进入判定** | 单测 `marker.test.mjs`（`assistantTextOf` 尸体样本） | 已实测 |
| A6 | 区间终点 = 标记消息前一个节点（标记消息不被吞） | 单测 `marker.test.mjs` | 已实测 |
| A7 | 幂等：处理后 markerSeq < `compaction/end` seq | 单测 `marker.test.mjs` | 已实测 |
| A8 | 事务事件序列与官方字节兼容 + 属主回合正确 | 既有 `tests/owner-turn.test.mjs`、`compact-range.test.mjs`（真 Session + 真事务） | 已实测 |
| A9 | 组合装载成功（新 config schema + 新构建） | `preflight_check` full 通过；boot 行 `0.2.0@1790479147323` 与 `0.2.1@1790480058993`（后者 live 58 / 需重启 0） | 已实测 |
| A10 | **线上真实压缩一笔**：块 → `detected` → `committed`，上下文显著缩小 | 2026-09-27 11:26 本会话实压：侧车 `detected`(seqFloor=745, chars=5041) → `committed`(shadowed 364 nodes, seqs 8-744, txnMs≈21890)；`context_health` 344,734 → 86,905 tok（−74.8%） | 已实测 |
| A11 | 零额外请求：压缩轮不产生额外的全上下文请求 | 事件流 seq745（标记）→ seq748（`compaction/start`）之间**零** `request/header`、零 `assistant/message`；压缩后首个请求在 seq760；存档 `createdAt` 与 `detected` 同秒（24 ms 级） | 已实测 |
| A12 | 非法块在下个 step 可见（告知真的注入） | 2026-09-27 尸体探针（故意写 118 字符短块）：侧车 `rejected`(chars=118, error 具体) **且同回合下一个 step 就收到可见告知**——含「未生效 / 历史未改动 / 原因 / 怎么修」四段 | 已实测 |
| A13 | 识别**只读文本块**：推理块与流式副本里的哨兵不参与判定 | 线上实证：标记消息事件含 **6 个**哨兵（`content[0]` reasoning 2 个 + `content[1]` text 1 个 + `stream` 镜像 3 个），仍判合法并压缩成功 | 已实测 |
| A14 | 区间端点正确：标记消息**自身不被吞** | 线上实证：`seqFloor=745` 即标记消息 seq，被遮蔽区间为 `8-744`——端点取「标记消息之前一个表层节点」 | 已实测 |
| A15 | 存档**不阻塞**提交：派发同步返回 `void`——**create 悬挂也不挂**（尸体）；reject / 同步抛都不逃逸异常 | `tests/archive.test.mjs` ①②②b；**变异实验**：把产物改成返回 Promise ⇒ 判据①当场变红（其余 5 条仍绿）⇒ 该判据有区分力 | 已实测 |
| A16 | 存档轨迹三态齐备且 `durationMs` 是真读数；并发派发走单飞（带连续跳过计数） | `tests/archive.test.mjs` ③④（注入时钟每次推进 100 ms ⇒ `durationMs > 0`，不是恒 0 占位） | 已实测 |
| A17 | 存档不再拖慢提交：部署后第一笔真实压缩的 `totalMs` 回落到百毫秒级，且侧车出现 `archive-dispatched`/`archive-settled` | 侧车 `compaction-trace.jsonl`（0.3.0 部署后待验） | **待线上验收** |

## 8 · 与实现的关系

- 主实现：`src/index.ts`（引擎类、标记路径注册、事务提交、告知）、`src/checkpoint-block.ts`
  （识别与包装，纯函数）、`src/marker.ts`（区间与幂等，纯函数）、`src/region.ts`（表层事务，
  继承 0.1.x，仅改「摘要入参为 thunk」）、`src/archive.ts`（存档**非阻塞派发**：单飞 + 三态留证，
  依赖全注入、可离线测）、`src/config.ts`、`src/trace.ts`
- 同语义副本：无（本仓为主副本）；消费方契约见 `dsh-compact-provider/docs/semantic.md`
- ⚠ **新增源文件后消费方副本要手工补硬链接**：`dsh-compact-provider` 以 `file:` 依赖本插件，
  pnpm 会建 `.pnpm/dsh-agent-compact@file+…` 实体，其中 `lib/*.js` 是**硬链接**（内容自动同步），
  但**新建的文件不会自动进去**——2026-09-27 两笔压缩各撞一次（本次缺 `lib/archive.js` 与
  `lib/types/archive.d.ts`）。补法：`ln <源>/lib/<新文件> <副本>/lib/<新文件>`，再用
  `diff -rq` 断言逐文件一致。
- 未实现/未验证部分**显式标注**：A1–A16 **全部已实测**（2026-09-27）；**A17 待线上验收**
  （0.3.0 部署后的第一笔真实压缩）。U1 两条时序**均已实测**（首笔回合间、第二笔回合内）。
  U5 已结案（见 §10），转为 U6（存档为何要 27 秒，根因在 `dsh-agent-checkpoint` 侧，未查）

## 9 · 实践修订记录

> 0.1.x 的完整事故史（2026-09-13 捕获漂移 / 09-14 闸门假拒绝与指令被重试吃掉 / 09-23 属主回合
> 硬判据与两个「假装提供信息」的字段）见本文件 git 历史。

- **2026-09-27 重设计：投递链 → 标记驱动（v0.2.0）**
  - **语义被推翻**：「压缩 = 引擎要 agent 总结，再把它的输出捕获为摘要」不成立。真语义是
    「**agent 的输出本身就是压缩请求**」——摘要不需要被要求，它本来就是 agent 的下一段输出。
  - **删除清单**（这才是重设计的实质）：`agentSummarize`、`AGENT_COMPACTION_INSTRUCTION`、
    `waitSummaryTurn`、`SURFACE_WAIT_MS`/`SURFACE_POLL_MS`、`instructionSurfaced`、
    `textOfEventData`、`selectSummaryCandidate`（猜候选）、`summarizeWithLlm`（replay 摘要）、
    `_registerAutomaticCompaction`（自动路径）、`compactNow` 的手动语义、压力策略配置七项。
  - **语义被补充**：识别从「猜哪条 assistant 消息是摘要」变成「**解析一个显式声明的块**」——
    判定由统计式（标记/最长）变为解析式（五层护栏），误判面从「像 checkpoint」收紧到
    「就是 checkpoint」。
  - **语义被补充（承重设计选择）**：区间终点取**标记消息之前**的节点 ⇒ 标记消息可以带工具
    调用、带寒暄、带任务产出。0.1.x 靠「checkpoint 独占一轮」的纪律保证正确，而纪律靠人守会
    失败（三次事故的根因之一）；现在它是**机制保证**。
  - **语义被补充（幂等）**：用事件流自身当状态（`markerSeq < 最近一次 compaction/end seq`），
    不额外落盘——重启重扫不会二次压缩。
  - **语义被补充（失败可见）**：非法块与事务失败都注入一条可见告知（`next-step`，不唤醒）。
    0.1.x 的失败只落 logger（**不落盘**）或 `compaction/end.error`（要人去读）。
  - **成本**：0.1.x 一次压缩 = 意图请求 + 摘要请求（实测 1,130,000 tok 量级）；现在**零额外
    请求**——块寄生在本来就要发生的那一轮里。
  - **实测读数（设计立项时的取证）**：40 个会话共 84 笔压缩起步 / 79 笔摘要（**6% 失败率**）；
    最近一笔（2026-09-26）正是投递链的捕获漂移（108 字符碎片被地板拦下，**上下文毫发未缩**）。
    官方 `compaction-basic`（auto:true，挂在会话预设 realm）**从未触发**（全部 84 笔都带
    `alice-self-compact`）——顺手确认了「框架自动压缩」在实际运行中未发生。
- **2026-09-27 线上首笔验收（v0.2.0 部署后当天，A10/A11/A13/A14）**
  - **本体**：本会话（`f551f590`）在 11:26 用新机制压了自己一笔——块写在干活那一轮的末尾
    （先汇报、后写块），**与任务产出共存**，正是承重设计要保证的用法。
  - **读数**：侧车 `detected`(11:26:27.757, `trigger=marker`, chars=5041, seqFloor=745) →
    `committed`(11:26:49.684, `shadowed 364 nodes (seqs 8-744)`)；`context_health`
    **344,734 → 86,905 tok（−74.8%）**；存档 `20260927-112627-2047ce`（7.0 MB）。
  - **零额外请求的铁证**：事件流 `seq745`（标记消息）→ `seq748`（`compaction/start`）之间
    **没有任何** `request/header` 或 `assistant/message`；压缩后首个模型请求在 `seq760`。
  - **一处设计假设被线上推翻（关键）**：识别「只读文本块」原先只是**论证**上的严谨，线上
    实测出它的**必要性**——那条标记消息事件里哨兵共 **6 个**（`content[0]` reasoning 块 2 个、
    `content[1]` text 块 1 个、`stream` 镜像 3 个）。若解析器读整个事件或读推理块，就会命中
    多哨兵 ⇒ 按「不猜」判 `invalid` ⇒ **第一次线上压缩当场失败**。护栏的「首要误触发面」不是
    假想敌。（A13）
  - **失败即静默的反面**：`compaction/start.turn = null`——提交发生在 `turn/end` 之后、下一
    `turn/start` 之前，读侧接受空闲属主（与 2026-09-23 的读侧硬判据一致）。
  - **暴露的可维护性缺口（自指闭环的收获）**：本笔 `committed` 行只有硬编码 `waitedMs: 0`，
    答不出「21.9 秒花在哪」——当场补 `archiveMs`/`txnMs`/`totalMs` 三字段并配尸体测试
    （v0.2.1）；根因候选记 U5。**验收不只是确认设计对，也包括让机制说出自己的代价。**
  - **失败路径同日验收（A12，v0.2.1 上线后）**：做了一次**明确标注的尸体探针**——故意写 118 字符
    的短块。结果双侧齐备：侧车 `rejected`(chars=118, error「正文 118 字符 < 下限 200（碎片拒收）」)
    ＋ **同一回合的下一个 step** 就收到可见告知（四段：未生效 / 历史未改动 / 原因 / 怎么修）。
    比设计预期更快——`next-step` 投递在**回合内**就生效，不必等下一轮。**失败不静默**因此有了
    可证伪的现场证据，而不是「实现里写了」的声明。
  - **接地副作用（同批）**：0.2.1 重启后第一次 `edit` 撞了编辑守卫（`file has not been read`）
    ——**重启会重置文件观测**，这条既是纪律也是实测（先 re-read 再改，不盲目重试）。
- **2026-09-27 线上第二笔 + 存档非阻塞化（v0.3.0）**
  - **U5 结案，且推翻了自己的假设**：第二笔 `committed` 行给出 `archiveMs = 27,270 ms` /
    `txnMs = 66 ms` / `totalMs = 27,336 ms`——**27 秒全在压缩前存档**，事务只 66 ms。首笔的
    推断（「存档 manifest `createdAt` 与 `detected` 同秒 ⇒ 不在存档」）错在**仪器**：`createdAt`
    与存档目录名用的都是**开始**时刻，同秒只能证明「它开始得早」，**不能证明「它结束得早」**。
    ⇒ 判耗时源只能用**分阶段计时**。
  - **阻塞性同时结案（不阻塞）**：跨存档窗口那条 `wsl sleep 40` 实测 `durationMs = 46,580 ms`，
    而同批 wsl 命令的冷启动固定开销是 6–7 秒（6,080/6,383/6,822/7,067/7,625/9,270）⇒
    `40,000 + 6,580`，**零额外延迟**（若事件循环被阻 27 秒，该值应约 67 秒）。
    **一处差点发生的误读**：窗口内日志（11:42:35.099 / 11:43:02.390）全在**两端**、中间 27 秒
    空白——但那是**事件驱动**的日志，空白是循环条件，**不构成证据**。
  - **语义被补充（非阻塞存档）**：「压缩前存档」原本是提交路径上的一个 `await`。实测它占 99.8%
    的耗时后改为**派发即返回**——依据是**两者无因果关系**：存档内容是 `storages` + `AGENTS.md`，
    而压缩只改**会话事件流**，并行不产生竞态。
  - **语义被补充（单飞与留证）**：并发派发会撞同一个 checkpoint 服务 ⇒ **单飞**（上一次未落定
    则跳过；跳过行带「已跑多久 + 第几次连续跳过」，于是**卡死可从侧车看出来**，§5.10）；
    服务不在本组合时**留证而非静默**——原先的 `if (checkpoint === undefined) return` 无声，
    从侧车上看与「存档成功」无从区分。
  - **一条字段的兴衰（可维护性）**：`archiveMs` 只活了一天（0.2.1 生、0.3.0 降为历史字段）。
    它精确地完成了使命——把 27 秒钉在存档上——然后因为「已不在提交路径上」而**必须退场**：
    留着它就是下一个恒 0 占位。**判据随契约更新，而不是把判据改到能过**：`trace.test.mjs` 里
    两条守 0.2.1 契约的断言同步改写，守卫强度不降反升（新增源码级断言「不许出现 `await` 存档」）。
  - **本笔同时实测 U1 的「回合内」分支**：块与**工具调用同轮**发出，压缩照常提交——§5.21
    「块可寄生在干活那一轮」从机制保证变成线上证据。
  - **判据自身的尸体测试（新增纪律实践）**：新写的 6 条判据在跑绿之后，做了一次**变异实验**
    ——把产物里的派发函数改成返回 Promise（即被根除的那个病），判据①**当场变红**且只有它变红。
    「绿」只证明判据被满足，**变异才证明它会拦**（§5.35 规则②、§5.9 规则 5）。

## 10 · 未决问题

- **U1** ~~`setImmediate` 提交的两条时序~~ **已结案（2026-09-27）**：回合间（首笔：`turn/end` →
  `compaction/start` → `compaction/end` → 下一 `turn/start`，`turn: null` 被读侧接受）与
  **回合内**（第二笔：块与工具调用同轮发出，压缩在未闭合的回合里提交成功）**两条均已实测**
- **U2** 是否需要一个「压缩体检」工具（列最近 N 笔压缩的轨迹 + 结果）——当前靠 `tail` 侧车
- **U3** 若某轮同时写了两个哨兵（意图不明）会被判 `invalid` 并告知；是否该支持「压最后一块」
  （当前判：**不猜**，宁可让 agent 重写）
- **U4** 预设 realm 里的官方 `compaction-basic`（auto:true）虽未观测到触发，但它的存在是
  一个「潜在的第二个压缩者」——是否该显式关掉（需要改预设 realm，属组合变更）
- **U5** ~~22 秒的延迟~~ **已结案（2026-09-27）**：耗时**全在压缩前存档**（27,270 ms，占 99.8%），
  原先「两次全表计量」的推断被证伪——`txnMs` 只 66 ms，说明那两次 `meter.measure` 在本量级
  （344k token）下并不构成瓶颈。存档已改为**非阻塞派发**（0.3.0），提交延迟待 A17 线上验收。
  详见 §9 第二笔条目（含「同秒 ⇒ 不在存档」那个仪器错误的正解）
- **U6** **存档为何要 27 秒（新 · 未查）**：7.26 MB / 4 个文件，而 sha256（`node:crypto`，≈30 ms）、
  压缩（`files/` 存**原样字节**，manifest `size` == 原文件大小）、体积、`storages` 规模
  （474 文件 / 14 MB）**已逐个排除**，事件循环也未被阻塞 ⇒ 它在 **await I/O**（嫌疑：逐文件
  `fsync` / 目录遍历 / cleanup 删旧存档）。调用面在 `dsh-agent-checkpoint` 侧（本引擎只调
  `checkpoint.create`）。**0.3.0 之后它已不再影响压缩延迟**，故降为「值得知道」而非「必须修」；
  但若它同时拖慢别的路径（例如周期存档），就该去查
