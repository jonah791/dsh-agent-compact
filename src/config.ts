/**
 * Configuration for the agent-driven compaction backend.
 *
 * 只有两项：开关与识别地板。旧的自动压缩策略字段（`auto` / `thresholdRatio` /
 * `retainRatio` / `modelPolicies` / `summarization*` / 重试预算）**全部删除**——
 * 本引擎没有自动路径，压缩只由 agent 说了算（AGENTS.md §2.4 / §5.21）。
 *
 * @module dsh-agent-compact/config
 */

import z from '@deepseek-ai/schemastery'

/** 识别地板缺省值：真实 checkpoint 是数千字符（历史样本 4637 / 4685 / 5599 / 6170）。 */
export const DEFAULT_MIN_CHECKPOINT_CHARS = 200

/** 未解析的部署配置。 */
export interface CompactConfig {
  /** 是否启用标记驱动路径。默认 `true`。 */
  enabled?: boolean
  /** 合法 checkpoint 正文的最小字符数。默认 {@link DEFAULT_MIN_CHECKPOINT_CHARS}。 */
  minCheckpointChars?: number
}

/** 解析后的不可变配置。 */
export interface ResolvedCompactConfig {
  readonly enabled: boolean
  readonly minCheckpointChars: number
}

/**
 * 解析并校验部署配置（显式的 resolve 步骤，不在使用处藏 `?? default`）。
 * @param config - cordis 传入的插件配置
 * @returns 解析后的配置
 * @throws 字段类型/取值非法时（fail loud，装载期可见）
 */
export function resolveConfig(config: CompactConfig = {}): ResolvedCompactConfig {
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    throw new Error('CompactConfig: enabled must be a boolean')
  }
  if (config.minCheckpointChars !== undefined) {
    if (typeof config.minCheckpointChars !== 'number'
      || !Number.isSafeInteger(config.minCheckpointChars)
      || config.minCheckpointChars < 1) {
      throw new Error('CompactConfig: minCheckpointChars must be a positive safe integer')
    }
  }
  return {
    enabled: config.enabled ?? true,
    minCheckpointChars: config.minCheckpointChars ?? DEFAULT_MIN_CHECKPOINT_CHARS,
  }
}

/** cordis 配置 schema（装载期校验；未知键由宿主 fail loud）。 */
export const Config: z<CompactConfig> = z.object({
  enabled: z.boolean(),
  minCheckpointChars: z.number().step(1).min(1),
})
