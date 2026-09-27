/**
 * trace.ts 单测：轨迹必须「可写、可读、容错、绝不反噬主流程」。
 *
 * 现场样本（2026-09-14 可维护性事故）：排障时无法回答「线上跑的是哪个构建 /
 * 投递断在哪一段 / 谁发的指令」——本模块就是让这些问题一条命令可答的证据层，
 * 所以：写失败不得抛、读坏行不得崩、字段缺省不得污染。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compactionTracePath,
  resolveHome,
  serializeTraceEntry,
  parseTraceEntries,
  readTraceEntries,
  appendTraceEntry,
  buildStamp,
  sessionTagOf,
} from '../lib/trace.js';
import { VERSION } from '../lib/version.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'compact-trace-'));
}

test('resolveHome：DSH_HOME 优先，空串回退 homedir/.dsh', () => {
  assert.equal(resolveHome({ DSH_HOME: 'E:/alice/.dsh' }, '/home/x'), 'E:/alice/.dsh');
  assert.equal(resolveHome({ DSH_HOME: '   ' }, '/home/x'), join('/home/x', '.dsh'));
  assert.equal(resolveHome({}, '/home/x'), join('/home/x', '.dsh'));
});

test('compactionTracePath：落在 DSH_HOME 下的固定文件名', () => {
  assert.equal(compactionTracePath('E:/alice/.dsh'), join('E:/alice/.dsh', 'compaction-trace.jsonl'));
});

test('serializeTraceEntry：稳定键序、单行、缺省字段不出现', () => {
  const line = serializeTraceEntry({
    atMs: 1789349944519,
    phase: 'queued',
    build: '0.1.3@1789349',
    seqFloor: 9459,
    target: 'next-turn',
  });
  assert.equal(line.split('\n').length, 1);
  assert.equal(
    line,
    '{"atMs":1789349944519,"phase":"queued","build":"0.1.3@1789349","seqFloor":9459,"target":"next-turn"}',
  );
  assert.ok(!line.includes('error'));
});

test('parseTraceEntries：坏行/空行跳过，好行保留', () => {
  const good = serializeTraceEntry({ atMs: 1, phase: 'boot', build: '0.1.3@2', note: 'x' });
  const text = ['', 'not json', good, '{"atMs":"oops","phase":"boot","build":"b"}', '   '].join('\n');
  const entries = parseTraceEntries(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].note, 'x');
});

test('appendTraceEntry：自动建目录并追加（不覆盖历史）', () => {
  const dir = tempDir();
  try {
    const path = join(dir, 'nested', 'compaction-trace.jsonl');
    assert.equal(appendTraceEntry(path, { atMs: 1, phase: 'boot', build: 'b1' }), true);
    assert.equal(appendTraceEntry(path, { atMs: 2, phase: 'begin', build: 'b1', seqFloor: 9459 }), true);
    const entries = readTraceEntries(path);
    assert.deepEqual(entries.map((e) => e.phase), ['boot', 'begin']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readTraceEntries：文件缺失返回空数组（不抛）', () => {
  assert.deepEqual(readTraceEntries(join(tmpdir(), 'definitely-absent-xyz', 'c.jsonl')), []);
});

test('appendTraceEntry：不可写路径返回 false 且不抛（观测不得反噬主流程）', () => {
  const dir = tempDir();
  try {
    const blocker = join(dir, 'file-not-dir');
    writeFileSync(blocker, 'x');
    assert.equal(appendTraceEntry(join(blocker, 'c.jsonl'), { atMs: 1, phase: 'boot', build: 'b' }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildStamp：形如 <version>@<mtimeMs>，可从模块 URL 自证构建', () => {
  const stamp = buildStamp(import.meta.url);
  // mtimeMs 带小数部分（Node 返回毫秒浮点）——契约是「版本 + @ + 数字」，不是整数
  // 版本段不锁具体号（锁了每次升版都要改测试）；真正的守卫是下面 startsWith(VERSION)
  assert.match(stamp, /^\d+\.\d+\.\d+@\d+(\.\d+)?$/);
  assert.ok(
    stamp.startsWith(VERSION + '@'),
    '版本段必须来自随源码走的 VERSION 常量（副本里 package.json 是陈旧快照）',
  );
  assert.equal(buildStamp('not a url://', '1.2.3'), 'unknown@unknown');
});

// ── 2026-09-23 补：构建自证的两个陷阱 ────────────────────────────────────────
// 现场：trace 的 boot 行写着 `0.1.0@1790131527923`，而那一刻新产物 region.js 的
// mtime 正是 1790131527923 ⇒ **mtime 真、版本假**（版本读的是 pnpm 重写过的副本
// package.json）。「线上跑的是哪个构建」因此只答对一半。

test('VERSION 与 package.json.version 一致（两处真源的守卫）', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version, '改版本时 src/version.ts 与 package.json 必须一起改');
});

test('buildStamp 不再从 package.json 取版本（源码级断言，防回退）', () => {
  const src = readFileSync(new URL('../src/trace.ts', import.meta.url), 'utf8');
  assert.ok(
    !src.includes("'package.json'"),
    'buildStamp 必须走 VERSION 常量——副本里的 package.json 是安装时快照，会谎报版本',
  );
});

// ── 2026-09-23 补：自动路径轨迹的字段 ────────────────────────────────────────
// 动机：自动路径（步间压力 / 溢出恢复 / 忙会话手动）原先零轨迹，失败只进
// `ctx.logger.warn`（宿主 logger 不落盘）⇒ 写坏会话后无法归因。补了 trigger 字段与
// sessionTagOf 单一真源，这里给它们配可证伪的判据。

test('sessionTagOf：剥掉通用前缀，产出**有区分力**的会话标识（尸体测试）', () => {
  // 尸体样本：真实 id 形如 session-<uuid>；直接 slice(0,8) 会得到每个会话都一样的
  // `session-` —— 那正是修复前的缺陷（字段零区分力，却看起来像在提供信息）。
  assert.equal(sessionTagOf({ id: 'session-9919ca78-70a7-478a-84cb-5a8eb2d824a1' }), '9919ca78');
  assert.equal(sessionTagOf({ id: 'session-005ddf46-13b3-4b73-9779-269daadaf57b' }), '005ddf46');
  // 两个不同会话必须给出不同 tag（这正是字段存在的理由）
  assert.notEqual(
    sessionTagOf({ id: 'session-9919ca78-70a7' }),
    sessionTagOf({ id: 'session-005ddf46-13b3' }),
  );
  // 无前缀 id 原样取前 8 位
  assert.equal(sessionTagOf({ id: 'abcdefghijkl' }), 'abcdefgh');
  // 拿不到时返回 undefined —— 轨迹字段可缺，不得抛
  assert.equal(sessionTagOf(undefined), undefined);
  assert.equal(sessionTagOf(null), undefined);
  assert.equal(sessionTagOf({}), undefined);
  assert.equal(sessionTagOf({ id: '' }), undefined);
  assert.equal(sessionTagOf({ id: 12345 }), undefined);
  assert.equal(sessionTagOf({ id: 'session-' }), undefined);
});

test('serializeTraceEntry：trigger 紧跟 side，缺省时不出现', () => {
  const line = serializeTraceEntry({
    atMs: 1,
    phase: 'abort',
    build: '0.1.4@9',
    side: 'engine',
    trigger: 'step-pressure',
    error: 'boom',
  });
  assert.equal(
    line,
    '{"atMs":1,"phase":"abort","build":"0.1.4@9","side":"engine","trigger":"step-pressure","error":"boom"}',
  );
  const noTrigger = serializeTraceEntry({ atMs: 1, phase: 'boot', build: '0.1.4@9' });
  assert.ok(!noTrigger.includes('trigger'));
});

// ── 2026-09-27 补：阶段耗时（线上首笔实测驱动）────────────────────────────────
// 现场：0.2.0 标记路径第一次真实压缩，detected→committed 之间隔了 **21.9 秒**，
// 而侧车那一行只写着 `waitedMs: 0`——**硬编码占位**，于是「这 21.9 秒花在哪」
// 答不出来（§5.22 五问之⑤形同虚设）。修法：按「存档 / 事务」两段如实计时。

test('serializeTraceEntry：阶段耗时按 archiveMs→txnMs→totalMs 落位，缺省不出现', () => {
  const line = serializeTraceEntry({
    atMs: 1790479609684,
    phase: 'committed',
    build: '0.2.0@1790479147323',
    trigger: 'marker',
    seqFloor: 745,
    archiveMs: 24,
    txnMs: 21890,
    totalMs: 21914,
    chars: 5041,
  });
  assert.equal(
    line,
    '{"atMs":1790479609684,"phase":"committed","build":"0.2.0@1790479147323",'
    + '"trigger":"marker","seqFloor":745,"archiveMs":24,"txnMs":21890,"totalMs":21914,"chars":5041}',
  );
  // 三个字段都可缺（boot / rejected 行没有耗时，不得凭空长出来）
  const bare = serializeTraceEntry({ atMs: 1, phase: 'boot', build: '0.2.0@9' });
  for (const field of ['archiveMs', 'txnMs', 'totalMs']) {
    assert.ok(!bare.includes(field), field + ' 不该在无耗时的行里出现');
  }
});

test('committed 行不再写硬编码 waitedMs: 0（源码级断言，防回退到占位）', () => {
  // 尸体样本：修复前 index.ts 的标记路径写死了 `waitedMs: 0` —— 它看起来像读数、
  // 实际是常量，让「耗时」这个问题永远得到错误的答案（0ms，而真相是 21.9s）。
  //
  // ⚠ 口径：判据只扫**代码行**。首版直接 `src.includes('waitedMs: 0')`，被本修复
  // 自己的历史说明注释命中而假红（2026-09-27 实测）——注释里描述缺陷是**应该的**，
  // 判据若连注释一起扫，就等于禁止记录历史。注释剥离器是朴素的（不处理字符串里的
  // `//`），对本文件够用；它只需保证「代码里的占位会红、注释里的引述不会红」。
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !code.includes('waitedMs: 0'),
    'committed 行必须写实测阶段耗时（archiveMs/txnMs/totalMs），不得回退到硬编码占位',
  );
  assert.ok(
    code.includes('archiveMs') && code.includes('txnMs') && code.includes('totalMs'),
    'commit() 必须按阶段计时并把三段读数交给两条入口',
  );
});

test('commit() 的计时覆盖两条入口（标记 / 工具），且返回值形状一致', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  // 两条入口都解构同一个返回形状——若某一处漏解构，那条路径的耗时就会静默丢失
  const destructured = src.match(/const \{ result, archiveMs, txnMs \} = await this\.commit\(/g) ?? [];
  assert.equal(destructured.length, 2, '标记路径与工具路径都必须解构 { result, archiveMs, txnMs }');
  assert.ok(
    /return \{ result, archiveMs, txnMs: Date\.now\(\) - txnStartedAt \}/.test(src),
    'commit() 必须回传真实事务耗时，而不是只回传 result',
  );
});
