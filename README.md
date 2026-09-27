<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: Agent 驱动压缩引擎：agent 在自己的输出里写 checkpoint 块即为压缩请求（零额外请求），替代官方面向重放的 compaction-basic；与 dsh-compact-provider 配成「想压就压」
  inject: 'agents','tokenMeter','sessions'
  tools: （无——注入 compaction 服务；工具原语在 dsh-compact-provider）
  runtime: host-only
  envDeps: 无（纯逻辑/标准 Node）
  boundary: 决定「我上下文」的插件——改动须先写尸体测试（§5.21 规则 4）
  compat: cordis ^4.0.1 / dsh-agent ^0.1.2-rc.1
-->
# dsh-agent-compact — Agent 驱动压缩引擎（标记即压缩）

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-compact"><img src="https://img.shields.io/badge/version-0.2.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/tests-51%20passed-brightgreen" alt="tests">
</p>

**一句话**：压缩**不需要被请求**——**agent 的输出本身就是压缩请求**。agent 在任意一轮写下合法的 checkpoint 块，引擎就在那条消息落盘后把「它之前」的历史换成这份摘要。

**为什么值得用**：官方 `compaction-basic` 靠服务端**重放**上下文来总结，上下文越长成本越陡。本引擎让摘要由 agent 自己供给，于是压缩**零额外请求**（0.1.x 的「意图请求 + 摘要请求」两笔、实测 ≈1.13M tok 的链路已整条删除）。

> ⚠ **本插件决定「我上下文」的命运**：它是压缩事务的执行者。改它必须先写尸体测试再部署（§5.21 规则 4），并在下一次真实压缩时验收。

## 定位与反定位

- **管**：**识别**（一个显式声明的块是不是合法 checkpoint）与**事务**（表层换血 + 事件序列 + 幂等 + 失败告知）。
- **不管**：入口约束与工具原语（`dsh-compact-provider` 管）；上下文提醒与炼化提醒（`dsh-agent-context`/`skill-forge` 管）。
- **不是**框架自动压缩：**结构上没有自动路径**——`compactIfNeeded` 恒 `null`，`compactNow`/`compactRegion` 恒抛。何时压 100% 归 agent（AGENTS.md §2.4 / §2.1）。

## 两种用法

```text
① 标记路径（主路径，零额外请求）
   agent 在**任意一轮**的输出里写 checkpoint 块 → 引擎把该消息之前的历史换成它
   块可以寄生在干活那一轮（先干完活、末尾写块），「独占一轮」降为推荐而非机制要求

② 工具路径（显式入口）
   session_compact({summary, reason}) → 同一事务、同一区间规则、同一幂等语义
   与标记路径只有「摘要从哪来」不同
```

## checkpoint 块的合法形态（五层护栏，全满足才识别）

| # | 护栏 | 为什么 |
|---|------|--------|
| ① | 恰一行以哨兵 `<!-- alice-compact -->` 开头（行首） | 行内提及不算意图 |
| ② | 哨兵**不在**围栏代码块内 | 引用符号 ≠ 发出信号 |
| ③ | 哨兵后紧跟 `<compacted-summary>` 且闭标签配对 | 外壳是契约的一部分 |
| ④ | 正文 ≥ `minCheckpointChars`（默认 200） | 碎片拒收（2026-09-26 事故形状） |
| ⑤ | 正文含**全部 8 个 section**（按序） | 结构即质量下限 |

**首要误触发面被结构性排除**：识别只读助手消息的**文本块**——推理块、工具调用参数、流式副本里的哨兵**永不进入判定**。这不是假想敌：线上首笔实测那条标记消息事件里哨兵共 **6 个**（推理块 2 + 文本块 1 + 流式镜像 3），只读文本块是它成功压缩的**必要条件**。

**幂等不落盘**：`markerSeq < 最近一次 compaction/end 的 seq` ⇒ 跳过。用事件流自身当状态，重启重扫不会二次压缩。

## 快速开始

**1) 装依赖**（引擎与 provider 是**回退对**——同进同退，禁止单侧回退）：

```jsonc
"dsh-agent-compact": "link:<工作区>/self-plugins/dsh-agent-compact",
"dsh-compact-provider": "link:<工作区>/self-plugins/dsh-compact-provider"
```

**2) 挂组合**（引擎行 + provider 行）：

```yaml
- id: agent-compact
  name: dsh-agent-compact
- id: compact-provider
  name: dsh-compact-provider
  config: { enabled: true, minCheckpointChars: 200 }
```

**3) 30 秒验证**：在任意一轮末尾写一块 checkpoint，随后：

```bash
tail -4 "$DSH_HOME/compaction-trace.jsonl"
# 成功：detected → committed（带 chars / 遮蔽节点数 / archiveMs / txnMs / totalMs）
# 写坏：rejected 行 + error（此时上下文**毫发不动**，且下个 step 会看到可见告知）
# 事务炸：abort 行 + error（同上，不替换）
```

## 配置

只留两项——**策略键已全部删除**（「怎么压」不再由配置决定，因为没有引擎发起的压缩可配）：

| 项 | 默认 | 说明 |
|----|------|------|
| `enabled` | `true` | 关掉即完全不注册标记路径 |
| `minCheckpointChars` | `200` | 正文下限（碎片地板） |

配置 schema 与类型见 `docs/semantic.md` §4.1（provider 复用同一 schema）。

## 落盘与自证

**`<DSH_HOME>/compaction-trace.jsonl`**——一行一阶段，`atMs` 单调。**两个写者共用一个文件**：

| 写者 | `side` | 阶段 |
|------|--------|------|
| 引擎（本插件） | 缺省 | `boot` / `detected` / `committed` / `skipped` / `rejected` / `abort` |
| 入口（provider） | `'provider'` | `requested` / `rejected` / `completed` / `failed` |

```bash
tail -6 "$DSH_HOME/compaction-trace.jsonl"
# ① 跑的是哪个构建 → build = "<版本>@<模块 mtime ms>"
# ② 谁发起 → trigger: marker（agent 自己）| tool（显式调用）+ agentId
# ③ 断在哪一段 → 阶段枚举；断点 = 最后一条非终态阶段
# ④ 结果质量 → committed 行 chars + 遮蔽节点数与 seq 区间
# ⑤ 耗时与预算 → archiveMs（存档）/ txnMs（事务）/ totalMs（端到端）
```

实测（2026-09-27 线上首笔）：

```json
{"phase":"detected", "trigger":"marker","seqFloor":745,"chars":5041, …}
{"phase":"committed","trigger":"marker","seqFloor":745,"chars":5041,
 "archiveMs":24,"txnMs":21890,"totalMs":21914,
 "note":"shadowed 364 nodes (seqs 8-744)"}
```

观测绝不反噬：落盘失败返回 `false`，压缩主流程照常（配尸体测试）。

## 生效判据与回退

**生效判据**：
1. `tail -1 "$DSH_HOME/compaction-trace.jsonl"` 的 `boot` 行 `build` mtime 等于当前 `lib/trace.js` mtime；
2. 生态级：`plugin_boot_status` 的 `liveNow` 含本插件；
3. 行为级：一次真实压缩走完 `detected` → `committed`，会话 token 实际下降。

> **重新构建 ≠ 生效**：产物 mtime 新只证明「构建过」，进程启动时间晚于产物 mtime 才算「在跑它」。

**回退**：
- 源码级：`git revert <commit>` → 重新构建 → `preflight_check`（full）→ 重启；
- 组合级：预设行加 `disabled: true`（压缩服务随之不可用——provider 必须同步停）；
- 版本级：本插件与 provider 是**回退对**（引擎 0.2.1 ↔ provider 0.3.0），不可只回退一侧。

## 测试

```bash
npm test        # tsc -p tsconfig.json && node --test "tests/*.test.mjs"
```

**51 例离线测试**，重点是**识别护栏的尸体样本**（每条护栏都喂一个「看起来像但要拒」的样本）：围栏内的哨兵、缺一节、乱序、108 字符碎片、多哨兵、空正文、工具调用里的块（不进入判定）、区间端点（标记消息不被吞）、幂等、轨迹字段序与容错解析。纯函数 + 薄 IO，无网络、无真实 LLM 依赖。

## 设计要点（不可违反）

- **区间终点 = 标记消息之前一个表层节点**：标记消息可以带工具调用、带寒暄、带任务产出而不被吞。0.1.x 靠「checkpoint 独占一轮」的纪律保证正确，而纪律靠人守会失败；现在它是**机制保证**。
- **供给式摘要**：`region.ts` 的 `summarize` 入参是 **thunk**——供给式摘要器永不调用它，因此不再为一次压缩重建几十万 token 的 replay 载荷。
- **先摘要、后开事务**：`compaction/start` 的 `turn` 取**提交那一刻**开着的回合（空闲则 `null`，读侧接受）。事务在同一 tick 内 `start → summary → end` 连续落盘。
- **失败必响**：非法块（`rejected`）与事务失败（`abort`）都落侧车 **+ 注入一条可见告知**（`next-step`，不唤醒）——0.1.x 的失败只落不落盘的 logger，或要人去读 `compaction/end.error`。
- **不越界清单**：不改写 system 节点；不删除事件（只做表层替换）；不在无哨兵时自行触发；不调 LLM。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：五层护栏、事件序列、调用点清单、A1–A14 可证伪验收、§9 线上首笔读数 |
| [dsh-compact-provider](https://github.com/jonah791/dsh-compact-provider) | 契约消费方（挂载与工具入口）——两份语义文档互相指认 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 生态中心 |

## License

MIT © jonah791

---

本插件属于爱丽丝 DSH 自研插件生态（见 [alice-digital-life](https://github.com/jonah791/alice-digital-life)）。
