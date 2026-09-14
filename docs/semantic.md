# 语义文档：智能体驱动压缩引擎（Agent-Driven Compaction Engine）

> ⚠ **0.1.4 已回退（2026-09-14，主人「回退压缩插件版本」）**：有界重发（`nextInstructionAttempt` / `MAX_INSTRUCTION_ATTEMPTS`）**已从构建中撤下**，代码保留在 git `ed4b4e0`；当前行为 = 0.1.3（单次投递 + 8 秒表层轮询重查）。撤下原因：入口侧（`dsh-compact-provider` 0.3.x 直触）一并回退，先恢复被验证可用的组合（engine 0.1.3 + provider 0.2.0 = turn 71 那次成功压缩）。
> 版本 v0.1.3（v0.1.4 已回退）· 2026-09-14 · 作者：爱丽丝 · 状态：**已实现**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：`self-plugins/dsh-agent-compact/src/{index,summarizer,region,config,types}.ts`

---

## 1 · 定位与反定位

**定位**：把「压缩」实现为**智能体自己的下一轮输出**——引擎把总结指令投给 owner agent，agent 在**暖 KV 前缀**上产出 `<compacted-summary>` checkpoint，引擎据此替换会话表层；事件序列与官方 `compaction-basic` **字节兼容**（日志可互换）。

**反定位（本文不管什么）**：
- 不管「何时该压」的决策——那属于 `dsh-compact-provider` 的入口（工具 / 直触）与**爱丽丝的常设授权**
- 不管提醒——【上下文提醒】/【压缩告警】属于 `dsh-agent-context`；压缩提醒（先炼化再压缩）属于 `dsh-agent-skill-forge`
- **不是** `auto` 自动压缩：本部署 `auto: false`（主人 2026-08-16「不要开自动压缩，别让框架强制影响你的决策」）。`auto: true` 时走的是 `agent/pre-step` 压力 + `agent/request-error` 溢出两条**官方 replay 摘要器**路径，与 agent 驱动是两条成本不同的路（replay = 独立请求全量载荷、无暖缓存；agent 驱动 = 自己的下一笔请求，实测 562,944/566,783 为 cacheRead）

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 意图请求 | 为在轮内调用入口而先发生的正常轮请求（实测 563,054 tok；`dsh-compact-provider` 直触可省掉它） |
| 摘要请求 | 模型看见全文并输出 checkpoint 的那笔请求（实测 566,783 tok = `compaction/summary.usage.totalTokens`） |
| 总结轮 | 指令投递后第一个出现 assistant 消息的 turn；捕获只取该轮的候选 |
| 表层（surface） | 模型可见的持久对话面；`user/message` 事件是**指令真的被看见**的唯一证据 |
| 捕获漂移 | 取到「不是 checkpoint」的助手文本当摘要（2026-09-13：117 字符碎片替换数千 token 历史） |
| shadowedRange | 被替换掉的表层区间 `{start,end}`；`shadowedSeqs` 是被遮蔽的节点 seq 列表 |
| 换血（replace） | 表层操作 `{op:'replace', startSeq, endSeq}`——**必须恰好三键**（多键被 append 处 fail-loud 拒绝） |

## 3 · 概念模型

```
入口（provider 的工具 / 直触）
   └─ compactNow(agent, signal, sourceCommandId)
        ├─ 选可压区间 selectCompactableRange → 无 → 直接返回
        ├─ 开启事务：compaction/start{compactionId, sourceCommandId, turn}
        ├─ agentSummarize(agent)
        │    ├─ 投递指令 agent.send(指令, 'next-turn', true)   ← 空闲会话由此自起总结轮
        │    ├─ waitSummaryTurn（等总结轮收口；封口即算完，不白等 120s）
        │    ├─ 表层取证 instructionSurfaced（user/message 含指令前 60 字符）
        │    │    └─ 未取证 → 有界重发（≤2 次）→ 仍无 → 抛错（fail loud）
        │    ├─ 选候选 selectSummaryCandidate（优先含 <compacted-summary> 块，否则最长）
        │    └─ 碎片拒收：< MIN_PLAUSIBLE_SUMMARY_CHARS(200) → 抛错，绝不替换历史
        ├─ 写 compaction/summary{summary, rawOutput, shadowedRange, shadowedSeqs, shadowedTokenCount, provider, model, usage}
        ├─ 注入承接消息（source={plugin:'compact', compactionId, sourceCommandId}）+ replace 表层
        ├─ compaction/end{compactionId, sourceCommandId, turn[, error]}
        └─ sessions.flush
```

不变量（invariants）：
1. **I1 无表层证据不捕获**：拿不到 `user/message` 里的指令痕迹 → 拒绝捕获并留 `compaction/end.error`（宁可压不成，不可压成错的）
2. **I2 一次事务一条摘要路径**：不得同时跑 agent 与 replay 两条 summarize（2026-09-13 双投递根因）
3. **I3 换血 op 恰好三键**：`{op,startSeq,endSeq}`
4. **I4 busy 会话不阻塞**：`compactNow` 在会话忙时把指令排入 inbox 并**立即返回**，事务在后台完成（错误只落 logger + `compaction/end.error`）
5. **I5 捕获必须按判据选**：一个 turn 可有多条 assistant 消息，选「含标记块 / 最长」，不选「最后一条」
6. **I6 重发有界**：投递尝试 ≤ `MAX_INSTRUCTION_ATTEMPTS(2)`

## 4 · 契约

### 4.1 配置（`AgentCompactEngine.Config`，由 provider 复用）
- `thresholdRatio` / `retainRatio` / `retainTokens`：自动压力路径的阈值与保留量
- `summarizationProvider` / `summarizationModel` / `maxTokens`：**replay** 摘要器的目标与上限
- `compactionRetries` / `maxOverflowRetries`：重试预算（溢出恢复默认 1）
- `modelPolicies`：按 provider/model 的覆盖
- `auto`：是否登记 `agent/pre-step` 压力与 `agent/request-error` 溢出两条**官方 replay** 路径——**本部署 false**

### 4.2 事件序列（事务的持久形状）
`compaction/start` → `agent/inbox/spliced{inserted}`（入队）→ `agent/inbox/spliced{removedCount}`（被某一步消费）→ `user/message`（表层落地；**时机不固定**，可能在下个 turn 边界）→ `compaction/summary` → `user/message`（replace 换血）→ `compaction/end`（携带 `error` 即失败）

### 4.3 裁决（纯函数优先）
- `textOfEventData(data) → string`：**形状宽容**取文本（`content` / `message.content` / `inserted[].content`）——初版只认一种形状 ⇒ 闸门 100% 假拒绝（2026-09-14）
- `instructionSurfaced(view, floor) → {surfaced, seqs}`：表层是否出现过指令（比对前 60 字符）
- `nextInstructionAttempt({attempt, surfaced, maxAttempts}) → 'accept'|'resend'|'fail'`：投递失败后的动作（2026-09-14 二次事故：指令被消费它的那一步的请求吃掉、该请求随即 provider 重试 → 指令蒸发）
- `selectSummaryCandidate(candidates) → {index, reason} | null`：优先含 `<compacted-summary>` 块者（取最长），否则取最长文本；附裁决理由（写日志）

### 4.4 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| `dsh-compact-provider` | `src/index.ts` → `compaction.compactNow(...)` | `session_compact` 工具 / 直触（pre-step、turn/end） |
| 引擎自身（真机自测） | `src/index.ts:_registerAutomaticCompaction` | 仅 `auto:true`：`agent/pre-step`（压力）、`agent/request-error`（溢出） |
| 引擎自身 | `src/index.ts:compactNow` | `inspectCompactionEntryState` 定 owner：空闲=同步执行；忙=排队 + 立即返回 |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：本引擎不做「该不该压」的价值判断，也不拦恶意调用（调用方是自有 provider）
- 不越界清单：不改写 system 节点（`node 0 holds the system prompt…` 会 fail loud）；不在 `auto:false` 时自行触发；不删除事件（只做表层替换）
- 失败面：① 投递失败 → 有界重发 → 仍失败则 `compaction/end.error`（**响**）② 捕获可疑（无表层证据 / 碎片）→ 拒绝捕获（**响**）③ 换血 op 非法 → 宿主 append 处 fail-loud 拒绝（**响**）——三处都**不静默**

## 6 · 与既有机制的关系

- AGENTS.md **§5.21**（压缩 checkpoint 纪律：独占一轮 / 压缩后查存档 / 真原文只在事件流）
- AGENTS.md **§5.15**（事件契约：`compaction/summary` → `compaction/end.error` 是首要证据；换血 op 三键）
- AGENTS.md **§4/§2.1**：压缩决策归爱丽丝，本引擎只提供「怎么压」的机械
- 与 `dsh-compact-provider` 的分工：provider 管**入口与授权**，引擎管**事务与捕获**

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据 | 状态 |
|---|-----------|------|------|
| A1 | 指令未进表层 → 拒绝捕获且 `compaction/end.error` 可见 | 事件流 7952（`never reached the model-visible surface`） | 已实测 |
| A2 | 表层落地晚于总结轮收口也能捕获（顺序不固定） | 事件流 8105/8106（表层 8105、摘要 8106） | 已实测 |
| A3 | 碎片（<200 字符）必被拒收 | 单测 `instruction-surfaced.test.mjs` 回归样本 | 已实测 |
| A4 | 重复形状（`data.content` / `data.message.content`）都判定为「已进表层」 | 单测 18/18 | 已实测 |
| A5 | 一次事务只有一条摘要路径（无双投递） | `scripts/compaction-forensics.py` injections=1 | 已实测 |
| A6 | 投递失败后有界重发（≤2 次）后仍无表层 → fail loud | 单测 `nextInstructionAttempt`（resend → fail） | 已实测（单测）/ **待线上验收**（真实重发） |
| A7 | busy 会话 `compactNow` 立即返回、事务后台完成 | 事件流 8092→8108（同轮内完成） | 已实测 |

## 8 · 与实现的关系

- 主实现：`src/index.ts`（引擎类与注册）、`src/summarizer.ts`（指令文本 / 投递 / 取证 / 候选选择）、`src/region.ts`（区间选择、表层事务、`compaction/*` 写入）、`src/config.ts`（策略解析）、`src/types.ts`
- 同语义副本：无（本仓库为主副本）；调用契约的消费方副本见 `dsh-compact-provider/docs/semantic.md`
- 未实现/未验证部分**显式标注**：① `auto:true` 的两条 replay 路径在本部署**未启用**，其行为仅有单测与代码证据 ② 重发路径尚无真实失败样本（A6 待线上验收）

## 9 · 实践修订记录

- **2026-09-13 首次实践（捕获缺陷）**
  - 语义**被确认**：事务形状、表层替换、`compaction/end.error` 为唯一失败信号
  - 语义**被补充**：捕获必须按判据选候选（标记块 / 最长），并加碎片拒收下限
  - 语义**被修正**：「入队 = 投递」被证伪——`agent/inbox/spliced` 的 inserted/removedCount 是同一投递的两个生命周期事件；判据只能是**表层 `user/message`**
  - 教训：真原文只在 append-only 事件流里（`<DSH_HOME>/sessions/…/session.v3.jsonl.zstd`）
- **2026-09-14 二次实践（闸门假拒绝）**
  - 语义**被修正**：事件形状必须**实测取证**——`instructionSurfaced` 初版只读 `data.message.content`，真实形状是 `data.content` ⇒ 恒 false ⇒ 第一次真实压缩被自己的闸门拦下（上下文卡在 512k）
  - 语义**被补充**：表层落地时机不固定（可能在下个 turn 边界）⇒ 判定前必须短轮询（`SURFACE_WAIT_MS=8000` / `SURFACE_POLL_MS=500`）
- **2026-09-14 三次实践（指令被重试吃掉 · v0.1.4）**
  - 语义**被补充**：投递失败（入队后被某步消费、该步请求随即 `assistant/attempt`+`llm/retry` → 指令随重建请求蒸发）必须**有界重发**（≤2 次），不再一次判死
  - 教训：判据（表层才算看见）与处置（没看见怎么办）要分开——判据不变，处置要有自愈

## 10 · 未决问题

- **U1** 重发上限是否该按「指令文本不变 + 表层层级」再收紧（当前 2 次，尚无真实重发样本）
- **U2** `auto:false` 下 `agent/pre-step` 压力路径完全未启用——是否需要一个「只观测不压缩」的压力信号（供提醒插件复用），由 `dsh-agent-context` 裁决
- **U3** 捕获后 `sessions.flush` 失败的补偿路径未定义（当前依赖宿主重放）
