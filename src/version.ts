/**
 * 构建版本常量（2026-09-23 新增）：让「线上跑的是哪个构建」**真的**可答。
 *
 * ## 为什么不能只读 `package.json`
 * `buildStamp()` 原先从模块文件出发读 `../package.json`。在**本插件被消费方以
 * `file:` 依赖硬链接**的场景下（`dsh-compact-provider` 就是这么装的），pnpm 会把
 * `package.json` **复制并重写**成安装时的快照——而 `lib/*.js` 是**硬链接**（改动即时
 * 可见）。于是同一个构建里：
 * - 代码 = 新的（硬链接）
 * - 版本号 = **旧的**（快照，实测恒 `0.1.0`，而源码树已是 `0.1.4`）
 *
 * 实测（2026-09-23）：`compaction-trace.jsonl` 的 boot 行写着 `0.1.0@1790131527923`，
 * 而那一刻 `lib/region.js` 的 mtime 正是 `1790131527923` —— **mtime 真、版本假**。
 * 五问里的第一问（线上跑的是哪个构建）因此只答对一半。
 *
 * ## 修法
 * 版本号随**源码**走：本常量编译进 `lib/version.js`，与其他产物同为硬链接 ⇒ 副本
 * 里也是新值。`package.json` 降级为回退来源（源码树内开发时仍可用）。
 *
 * ⚠ **两处真源的风险与守卫**：本常量与 `package.json` 的 `version` 必须一致——由
 * `tests/trace.test.mjs` 的断言守住（不一致即测试红）。改版本时**两处一起改**。
 *
 * @module dsh-agent-compact/version
 */

/** 本插件版本（与 `package.json` 的 `version` 必须一致，测试守门）。 */
export const VERSION = '0.1.4'
