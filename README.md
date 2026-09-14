<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: Agent 驱动压缩引擎：由 agent 自己在暖 KV 前缀上总结会话（省整段重放请求），替代官方面向重放的 compaction-basic；与 dsh-compact-provider 配成「想压就压」
  inject: 'llm','tokenMeter','sessions'
  tools: （无——注入 compaction 服务；工具原语在 dsh-compact-provider）
  runtime: host-only
  envDeps: 无（纯逻辑/标准 Node）
  boundary: 决定「我上下文」的插件——改动须先写尸体测试（§5.21 规则 4）
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-compact — Agent 驱动压缩引擎

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-compact"><img src="https://img.shields.io/badge/version-0.1.3-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/tests-26%20passed-brightgreen" alt="tests">
</p>

**一句话**：把压缩从「官方重放式 summarization」换成「**agent 自己总结自己**」——总结请求在**暖 KV 前缀**上产出，不触发巨型重放请求（实测一次压缩的直接请求成本 ≈1.1M tok 且 99% 缓存命中）。

**为什么值得用**：官方 `compaction-basic` 靠服务端重放上下文来总结，上下文越长成本越陡；本引擎让 agent 直接在当前会话里产出 `<compacted-summary>` checkpoint，并**落全程自证轨迹**——压缩失败时，一条 `tail` 就能答完「谁发起 / 断在哪一段 / 为什么失败」。

> ⚠ **本插件决定「我上下文」的命运**：它是压缩事务的执行者。改它必须先写尸体测试再部署（§5.21 规则 4），并在下一次真实压缩时验收。

## 定位与反定位

- **管**：压缩事务本身——指令投递（queued→surfaced）、摘要捕获（captured）、表层换血（summary replace）、失败账（abort/error）。
- **不管**：入口约束与「什么时候压」的决策（`dsh-compact-provider` 管）；上下文提醒与炼化提醒（`dsh-agent-context`/`skill-forge` 管）。
- **不是**框架自动压缩：`auto: false` 保持关闭；压缩何时发生由 agent 自主决策（工具路径）。

## 能力

| 面 | 内容 |
|----|------|
| 注入的服务 | `ctx.compaction`（CompactionEngine 子类）——由 `dsh-compact-provider` 挂载后即为宿主压缩 seam |
| 轨迹面 | 每笔事务每阶段落一行 `<DSH_HOME>/compaction-trace.jsonl` |
| 转出原语 | `compactTrace` / `appendTraceEntry` / `serializeTraceEntry` / … 供消费方复用（判据单一真源） |
| 工具面 | 无（服务型插件；`session_compact` 工具原语在同配对的 provider） |

## 快速开始

**1) 装依赖**（引擎与 provider 是**回退对**——同进同退，禁止单侧回退）：

```jsonc
"dsh-agent-compact": "link:<工作区>/self-plugins/dsh-agent-compact",
"dsh-compact-provider": "link:<工作区>/self-plugins/dsh-compact-provider"
```

**2) 挂组合**（引擎行 + provider 行；`auto: false` 保持不动）：

```yaml
- id: agent-compact
  name: dsh-agent-compact
- id: compact-provider
  name: dsh-compact-provider
```

**3) 30 秒验证**：调 `session_compact {reason:'…'}` → 该轮只输出 checkpoint（**独占一轮**），任务续做从下一轮开始；随后：

```bash
tail -3 "$DSH_HOME/compaction-trace.jsonl"
# 成功：本笔 commandId 的 begin → queued → waited → surfaced → captured
# 失败：abort 行 + error（此时上下文**不应**变化——没压成就不许动表层）
```

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `thresholdRatio` | `0.8` | 压力阈值比例（上下文占用触发线） |
| `retainRatio` | `0.16` | 压缩后保留的原文尾部比例 |
| `retainTokens` | 路由策略解析 | 保留 token 绝对值 |
| `summarizationProvider` / `summarizationModel` | 路由策略解析 | 总结用的模型路由 |
| `maxTokens` | 路由策略解析 | 总结输出上限 |
| `compactionRetries` / `maxOverflowRetries` | 路由策略解析 | 重试上限 |
| `modelPolicies` | `[]` | 按精确路由（provider/model）定向覆盖 |
| `auto` | `false` | **保持关闭**——本插件在「agent 自主决策」形态下运行 |

配置 schema 与类型见 `docs/semantic.md` §4.1（provider 复用同一 schema）。

## 落盘与自证

**`<DSH_HOME>/compaction-trace.jsonl`**——一行一阶段，`atMs` 单调。**两个写者共用一个文件**：

| 写者 | `side` | 阶段 |
|------|--------|------|
| 引擎（本插件） | 缺省 | `boot` / `begin` / `queued` / `waited` / `surfaced` / `captured` / `abort` |
| 入口（provider） | `'provider'` | `requested` / `rejected` / `completed` / `failed` |

```bash
tail -6 "$DSH_HOME/compaction-trace.jsonl"
# ① 跑的是哪个构建 → build = "<版本>@<模块 mtime ms>"
# ② 谁发起 / 投给谁 → provider 行 commandId:alice-self-compact + agentId + reason 摘要
# ③ 断在哪一段 → 阶段枚举；断点 = 最后一条非 abort 阶段
# ④ 结果质量 → captured 行 chars（checkpoint 字符数）+ markerOk（是否含 <compacted-summary>）
# ⑤ 耗时与预算 → waitedMs vs 120s 等总结轮 / 8s 表层窗口
```

失败免费指纹：`compaction/end.error` 文案**有没有含 `within 8000ms`** 可判它出自哪个构建。观测绝不反噬：落盘失败返回 `false`，压缩主流程照常。

## 生效判据与回退

**生效判据**：
1. `tail -1 "$DSH_HOME/compaction-trace.jsonl"` 的 `boot` 行 `build` mtime 等于当前 `lib/trace.js` mtime；
2. 生态级：`plugin_boot_status` 的 `liveNow` 含本插件；
3. 行为级：成功触发一次压缩（`compaction/start` → `compaction/end` 无 error，上下文 token 实际下降）。

> **重新构建 ≠ 生效**：构建产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。

**回退**：
- 源码级：`git revert <commit>` → 重新构建 → `preflight_check`（full）→ 重启；
- 组合级：预设行加 `disabled: true`（压缩服务随之不可用——provider 必须同步停）；
- 版本级：本插件与 provider 是**回退对**（引擎 0.1.3 ↔ provider 0.2.0），不可只回退一侧。

## 测试

```bash
npm test        # tsc -p tsconfig.json && node --test "tests/*.test.mjs"
```

**26 例离线测试**，含：范围判定（`selectCompactableRange`）、摘要候选选择（`selectSummaryCandidate`，标记块优先 + 拒收碎片）、投递重发判定（`nextInstructionAttempt`）、轨迹序列化/容错解析（坏行跳过）。纯函数 + 薄 IO，无网络、无真实 LLM 依赖。

## 设计要点（不可违反）

- **checkpoint 独占一轮**（§5.21 规则 1）：总结指令要求 agent 当轮**只**产出 `<compacted-summary>`——工具调用会让捕获漂移到后续消息。
- **三种失败形态**（事件流判据）：
  ① 表层始终无 `user/message` ⇒ fail-loud 拒收、上下文毫发未缩；
  ② 失败后指令残留、重启后浮出 ⇒ 产生**孤儿 checkpoint**（无事务可捕获）；
  ③ 捕获到碎片（远小于 checkpoint 应有大小）⇒ 拒收。
- **投递语义**：入队 ≠ 投递——`agent/inbox/spliced` 的 inserted/removedCount 是同一投递的两个生命周期事件；判据只能是表层 `user/message`。
- **KV 友好**：总结请求走暖前缀复用缓存（一次压缩两笔请求 ~1.13M tok，摘要请求是本质、意图请求可省）。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：事务形状、裁决表、调用点清单、§9 实践修订（含 2026-09-14 五问自证） |
| [dsh-compact-provider](https://github.com/jonah791/dsh-compact-provider) | 契约消费方（入口/决策留痕）——两份语义文档互相指认 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 生态中心 |

## License

MIT © jonah791

---

本插件属于爱丽丝 DSH 自研插件生态（见 [alice-digital-life](https://github.com/jonah791/alice-digital-life)）。