# 语义文档：标记驱动压缩引擎（Marker-Driven Compaction Engine）

> 版本 v0.2.1 · 2026-09-27 · 作者：爱丽丝 · 状态：**已实现（线上首笔压缩已验收；A12 待验）**
> 主人指令：「重新设计压缩插件，围绕智能体自主压缩」（2026-09-27）
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-agent-compact/src/{index,checkpoint-block,marker,region,config,trace}.ts`
> ⚠ 0.1.x 的投递链设计（`agentSummarize` / 指令投递 / 表层取证 / 候选捕获）已**整体删除**；
> 其完整文档与事故史见本文件 git 历史（`git log -p -- docs/semantic.md`）。本文只描述 0.2.x
> 的现状与继承下来的判据。
> ✅ 线上首笔（2026-09-27 11:26，本会话）已实测通过：`detected → committed`、上下文
> 344,734 → 86,905 tok、标记消息与事务之间零额外请求（§9 有完整读数）。

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
| 缺省 | `committed` | 表层已换血（`note` 含遮蔽节点数与 seq 区间；`archiveMs`/`txnMs`/`totalMs` 给阶段耗时） |
| 缺省 | `skipped` | 是意图但没压（幂等 / 无可压区间 / 拿不到 agent），`note` 给理由 |
| 缺省 | `rejected` | **有哨兵但不合法**——写坏了（`error` 给具体护栏） |
| 缺省 | `abort` | 事务抛错（`error` 给原因） |
| `provider` | `requested`/`rejected`/`completed`/`failed` | 工具入口侧四阶段 |

**断点即最后一条非终态阶段**。`build` 字段自证「线上跑的是哪个构建」（版本段取自随源码走的
`VERSION` 常量，不信消费方副本的陈旧 `package.json`）。

**耗时三字段（0.2.1 补，线上首笔实测驱动）**：`archiveMs`（压缩前存档）/ `txnMs`（表层替换事务，
含 `region.ts` 对整张表层做的**两次** `meter.measure`）/ `totalMs`（`detected`→`committed` 端到端）。
补它们是因为 0.2.0 的 `committed` 行只写了一个**硬编码** `waitedMs: 0`——看起来像读数、实际是常量，
于是「detected 到 committed 之间那 21.9 秒花在哪」答不出来（§5.22 五问之⑤形同虚设）。

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
| A9 | 组合装载成功（新 config schema + 新构建） | `preflight_check` full 通过；`compaction-trace.jsonl` boot 行 `0.2.0@1790479147323` | 已实测 |
| A10 | **线上真实压缩一笔**：块 → `detected` → `committed`，上下文显著缩小 | 2026-09-27 11:26 本会话实压：侧车 `detected`(seqFloor=745, chars=5041) → `committed`(shadowed 364 nodes, seqs 8-744, txnMs≈21890)；`context_health` 344,734 → 86,905 tok（−74.8%） | 已实测 |
| A11 | 零额外请求：压缩轮不产生额外的全上下文请求 | 事件流 seq745（标记）→ seq748（`compaction/start`）之间**零** `request/header`、零 `assistant/message`；压缩后首个请求在 seq760；存档 `createdAt` 与 `detected` 同秒（24 ms 级） | 已实测 |
| A12 | 非法块在下个 step 可见（告知真的注入） | 待一次真实误写 | **待线上验收** |
| A13 | 识别**只读文本块**：推理块与流式副本里的哨兵不参与判定 | 线上实证：标记消息事件含 **6 个**哨兵（`content[0]` reasoning 2 个 + `content[1]` text 1 个 + `stream` 镜像 3 个），仍判合法并压缩成功 | 已实测 |
| A14 | 区间端点正确：标记消息**自身不被吞** | 线上实证：`seqFloor=745` 即标记消息 seq，被遮蔽区间为 `8-744`——端点取「标记消息之前一个表层节点」 | 已实测 |

## 8 · 与实现的关系

- 主实现：`src/index.ts`（引擎类、标记路径注册、事务提交、告知）、`src/checkpoint-block.ts`
  （识别与包装，纯函数）、`src/marker.ts`（区间与幂等，纯函数）、`src/region.ts`（表层事务，
  继承 0.1.x，仅改「摘要入参为 thunk」）、`src/config.ts`、`src/trace.ts`
- 同语义副本：无（本仓为主副本）；消费方契约见 `dsh-compact-provider/docs/semantic.md`
- 未实现/未验证部分**显式标注**：A12（非法块告知）待一次真实误写；U1 的「回合间」时序已实测
  （2026-09-27 首笔即回合间：`compaction/start` 落在 `turn/end` 之后、下一 `turn/start` 之前），
  「回合内」时序待一笔；U5（22 秒的去向）待带阶段计时的下一笔实测确认

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

## 10 · 未决问题

- **U1** `setImmediate` 提交的两条时序（回合内 / 回合间）：**回合间已实测**（2026-09-27 首笔，
  `turn/end` → `compaction/start` → `compaction/end` → 下一 `turn/start`，`turn: null` 被读侧接受）；
  回合内（压缩与未闭合回合并存）待一笔
- **U2** 是否需要一个「压缩体检」工具（列最近 N 笔压缩的轨迹 + 结果）——当前靠 `tail` 侧车
- **U3** 若某轮同时写了两个哨兵（意图不明）会被判 `invalid` 并告知；是否该支持「压最后一块」
  （当前判：**不猜**，宁可让 agent 重写）
- **U4** 预设 realm 里的官方 `compaction-basic`（auto:true）虽未观测到触发，但它的存在是
  一个「潜在的第二个压缩者」——是否该显式关掉（需要改预设 realm，属组合变更）
- **U5** **22 秒的延迟（0.2.1 待测）**：首笔 `detected`→`committed` 实测 21.9 秒，而存档
  `createdAt` 与 `detected` 同秒 ⇒ 时间不在存档，指向 `region.ts` 对整张表层做的**两次**
  `meter.measure`（`prepareCompaction` 与 `assertSelectedSpanStable` 各一次，实际 344k token）。
  这是**继承自 0.1.x 的既有成本**（旧路径在此之上还要叠加一次可达 120 秒的 LLM 摘要请求），
  本轮未改。0.2.1 已补 `archiveMs`/`txnMs`/`totalMs` 三字段以便下一笔**归因到实证**；
  若确认是计量，再评估「复用首次计量 / 让计量器按节点缓存」是否安全（**不得**削弱
  `assertSelectedSpanStable` 的「表层未变」检查——那条检查是历史改写的守门人）
