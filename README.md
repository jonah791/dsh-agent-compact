# dsh-agent-compact — DSH 的 Agent 驱动压缩插件

**为 DeepSeek Harness (DSH) 打造的 Agent 驱动会话压缩插件。** 与官方后端把整个会话历史重放到独立 LLM 请求里做总结不同，本插件**让 agent 总结自己的对话**——摘要直接从模型已经持有的上下文里产出，命中提供方 KV 缓存，不再构造巨型重放请求。

> 状态：可用原型，已在真实生产会话中完整验证（见[实测证据](#实测证据)）。DSH 为预览版（0.1.0-rc），无兼容承诺。

## 功能特性

- **Agent 驱动压缩**：让 agent 总结自己的对话——摘要从模型已持有的上下文产出，命中提供方 KV 缓存，不构造巨型重放请求
- **事务兼容**：与官方 compaction 协议一致（start/summary/end 封装）
- **生产验证**：已在真实会话验证（46 万 token 场景）

## 问题

官方压缩后端（`@deepseek-ai/dsh-compaction-basic`）通过把完整 surface 重放进一个新 LLM 请求来做总结（`buildSummarizationInput` 无截断）。当会话膨胀到一定程度，这个重放请求会在传输层失败：

- 真实故障：会话膨胀至 **约 46 万 token 输入**（664 个 surface 节点）→ `compaction/end` 报 `error: "DeepSeek API request to https://api.deepseek.com failed"`
- 连续 5 次 `/compact` 均以同一 TRANSPORT 错误失败；每次重试都重新构造同一个无上限的重放请求
- 讽刺的是：官方路径在会话小时能成功，随会话膨胀退化为必然失败——而膨胀恰恰是最需要压缩的时刻

## 方案：让 agent 总结自己的上下文

压缩流程变为：

1. `compaction/start` —— 与官方完全相同的事务封装
2. 向 agent 的收件箱注入总结指令（next-turn 投递）
3. agent 基于**当前上下文**直接写出 checkpoint 摘要——提供方的 KV cache 里早已缓存了这些内容
4. 捕获并校验摘要（`agentSummarize`：非空、比原文小）
5. `compaction/summary` → surface `replace` → `compaction/end` → flush —— **与官方事务格式字节级兼容**

### 实测证据

在同一个曾连续失败 5 次的会话上验证（总结轮 turn 24）：

| 指标 | 数值 |
|---|---|
| `inputTokens` | 865 |
| `cacheReadTokens` | **568,832**（KV 缓存命中——agent 自己的上下文） |
| `outputTokens` | 1,933 |
| 结果 | `Compacted 664 history items (~460634 tokens)` |
| `compaction/end` | 无 `error` 字段 |

## 架构

`src/index.ts` —— `AgentCompactEngine extends CompactionEngine`（来自 `@deepseek-ai/dsh-compaction`）：

- `compactNow()` —— **agent 驱动路径**（`/compact` 命令使用）：`agentSummarize` 捕获 agent 自己产出的 checkpoint 消息
- `compactRegion()` / `compactIfNeeded()` —— 委托官方实现处理区域压缩与自动压缩

`src/summarizer.ts` —— `agentSummarize`（注入指令、捕获总结轮的 `assistant/message`、校验）与 `summarizeWithLlm`（官方直调兜底）。

`src/region.ts` —— 事务层：`compaction/start → compaction/summary → user/message replace → compaction/end → flush`、`compactCheckpointSource`、`toolPairingBalancedBefore/After`、平衡边界检查。

## 安装

两种接入方式：

### A. 原地替换官方后端（已验证）

预设文件引用包名 `@deepseek-ai/dsh-compaction-basic`，而 Loader 从**宿主进程**解析该包名——预设行里写第三方包名会报 `MODULE_NOT_FOUND`。因此已验证的接入方式是把官方包实现原地替换：

1. 构建：`pnpm run build`（产出 `lib/`）
2. 备份 `node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js` → `index.js.bak-official`
3. 把本包的 `lib/{index,region,summarizer,config,types}.js` 与 `lib/types/` 复制进 `node_modules/@deepseek-ai/dsh-compaction-basic/lib/`

回滚：把 `index.js.bak-official` 复制回去即可。

### B. 作为独立包接入（理想形态，需上游配合）

预设名必须能被宿主解析，所以独立包路径需要上游配合：要么官方预设开放可插拔的压缩 provider 槽位，要么 Loader 增加 profile 级解析回退。这正是[上游讨论帖](#)里提出的诉求。

## 路线图 / 给上游的建议

- 短期：官方 `buildSummarizationInput` 应截断或流式化，而不是构造无上限的重放请求（TRANSPORT 失败的根因）
- 中期：把压缩总结器做成可插拔 provider，使 agent 驱动总结可从预设中选择——本包即参考实现
- 本仓库已按 CONTRIBUTING.md 建议挂 `dsh-plugin` topic 发布

## 许可

MIT