# dsh-agent-compact

**Agent-driven compaction for DeepSeek Harness (DSH).** Instead of replaying the entire conversation into a separate LLM request, this plugin asks the agent to summarize its *own* conversation — the summary is produced from context the model already holds, hitting the provider KV cache instead of building a giant replay payload.

> Status: working proof-of-concept, verified in a real production session (see [Evidence](#evidence)). DSH is pre-release (0.1.0-rc); no compatibility promise.

## Problem

The official compaction backend (`@deepseek-ai/dsh-compaction-basic`) summarizes history by **replaying the full surface into a fresh LLM request** (`buildSummarizationInput` has no truncation). When a session grows large, that replay request fails at the transport layer:

- Real-world failure: session at **~460k input tokens** (664 surface nodes) → `compaction/end` with `error: "DeepSeek API request to https://api.deepseek.com failed"`
- 5 consecutive `/compact` attempts failed with the same TRANSPORT error as the session grew
- Every retry re-pays the same cost: a full-history replay, cold cache, doomed to fail again

## Solution

**Let the agent summarize its own context.** The compaction flow becomes:

1. `compaction/start` — same transaction envelope as official
2. Inject `AGENT_COMPACTION_INSTRUCTION` into the agent's inbox (next-turn delivery)
3. The agent writes the checkpoint summary from its **current context** — no replay, no giant request
4. The summary message is captured (`agentSummarize`) and validated (non-empty, smaller than the original)
5. `compaction/summary` → surface `replace` → `compaction/end` → flush — **byte-compatible with the official transaction format**

Measured in the verification session (turn 24, the summarizing turn):

| metric | value |
|---|---|
| `inputTokens` | 865 |
| `cacheReadTokens` | **568,832** (KV cache hit — the agent's own context) |
| `outputTokens` | 1,933 |
| result | `Compacted 664 history items (~460634 tokens)` |
| `compaction/end` | no `error` field |

## Architecture

`src/index.ts` — `AgentCompactEngine extends CompactionEngine` (from `@deepseek-ai/dsh-compaction`):

- `compactNow()` — **agent-driven path** (used by `/compact`): `agentSummarize` captures the agent's own checkpoint message
- `compactRegion()` / `compactIfNeeded()` — delegate to the official implementation for region/automatic compaction

`src/summarizer.ts` — `agentSummarize` (inject instruction, capture the summary turn's `assistant/message`, validate) and `summarizeWithLlm` (official direct-call fallback).

`src/region.ts` — transaction layer: `compaction/start → compaction/summary → user/message replace → compaction/end → flush`, `compactCheckpointSource`, `toolPairingBalancedBefore/After`, balanced-boundary checks.

## Install

Two ways to wire it into a DSH profile:

### A. Drop-in replacement of the official backend (verified)

The preset files reference the package name `@deepseek-ai/dsh-compaction-basic`, and the Loader resolves that name **from the host process** — a third-party package name in the preset line fails with `MODULE_NOT_FOUND`. The verified wiring therefore replaces the official package's implementation in place:

1. Build: `pnpm run build` (emits `lib/`)
2. Back up `node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js` → `index.js.bak-official`
3. Copy this package's `lib/{index,region,summarizer,config,types}.js` + `lib/types/` into `node_modules/@deepseek-ai/dsh-compaction-basic/lib/`

Rollback: copy `index.js.bak-official` back.

### B. As a standalone package (ideal, blocked upstream)

The preset name must resolve from the host, so the standalone path needs upstream cooperation: either the official preset gains a pluggable compaction-provider slot, or the Loader gains a profile-scoped resolution fallback. This is the ask in [the upstream discussion](#).

## Roadmap / upstream ask

- Short-term: official `buildSummarizationInput` should truncate/stream instead of building an unbounded replay (root cause of the TRANSPORT failures)
- Medium-term: a pluggable compaction provider so agent-driven summarization can be selected from the preset (this package as the reference implementation)
- This package is published with the `dsh-plugin` topic per CONTRIBUTING.md

## License

MIT
