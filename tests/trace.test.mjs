/**
 * trace.ts 单测：轨迹必须「可写、可读、容错、绝不反噬主流程」。
 *
 * 现场样本（2026-09-14 可维护性事故）：排障时无法回答「线上跑的是哪个构建 /
 * 投递断在哪一段 / 谁发的指令」——本模块就是让这些问题一条命令可答的证据层，
 * 所以：写失败不得抛、读坏行不得崩、字段缺省不得污染。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
} from '../lib/trace.js';

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
  assert.match(stamp, /^0\.1\.\d+@\d+(\.\d+)?$/);
  assert.equal(buildStamp('not a url://', '1.2.3'), 'unknown@unknown');
});
