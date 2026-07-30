// #60（批5 第5刀 / ADR-0032 / G4）grep 引擎 fs seam 锁定测试
// 纯核心 matchInFiles：注入内存 fake read，不碰磁盘。
// 锁定行为：匹配/聚合/include 过滤/截断/错误处理——重构后不改一行仍全绿。

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';

import { matchInFiles, createGrep } from '../dist/subagent/grep-utils.js';

// ── 内存 fs 工具 ──────────────────────────────────────────────
/** 构造 fake read：从 Map<absPath, content> 读取；不在 map 中则抛 ENOENT */
function fakeRead(fileMap) {
  return async (absPath) => {
    if (fileMap.has(absPath)) return fileMap.get(absPath);
    throw new Error(`ENOENT: no such file: ${absPath}`);
  };
}

describe('#60 matchInFiles 纯核心（内存 fs）', () => {
  test('基本匹配：正确返回 path（相对）、line（1-based）、text', async () => {
    const files = ['/proj/src/a.ts', '/proj/src/b.ts', '/proj/lib/c.js'];
    const content = new Map([
      ['/proj/src/a.ts', 'hello world\nfoo bar\nhello again'],
      ['/proj/src/b.ts', 'nothing here'],
      ['/proj/lib/c.js', 'hello from js'],
    ]);

    const result = await matchInFiles(files, fakeRead(content), 'hello', { baseDir: '/proj' });

    assert.equal(result.truncated, false);
    assert.equal(result.totalMatches, 3);
    assert.deepEqual(result.results, [
      { path: 'src/a.ts', line: 1, text: 'hello world' },
      { path: 'src/a.ts', line: 3, text: 'hello again' },
      { path: 'lib/c.js', line: 1, text: 'hello from js' },
    ]);
  });

  test('include glob 过滤：*.ts 只匹配 .ts（ADR-0021 锚定，.tsx/.ts.bak 不命中）', async () => {
    const files = ['/p/a.ts', '/p/b.tsx', '/p/c.ts.bak', '/p/d.js'];
    const content = new Map([
      ['/p/a.ts', 'match'],
      ['/p/b.tsx', 'match'],
      ['/p/c.ts.bak', 'match'],
      ['/p/d.js', 'match'],
    ]);

    const result = await matchInFiles(files, fakeRead(content), 'match', {
      baseDir: '/p',
      include: '*.ts',
    });

    assert.equal(result.totalMatches, 1);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].path, 'a.ts');
  });

  test('include glob ** 跨目录匹配', async () => {
    const files = ['/p/src/deep/x.ts', '/p/y.ts'];
    const content = new Map([
      ['/p/src/deep/x.ts', 'target'],
      ['/p/y.ts', 'target'],
    ]);

    const result = await matchInFiles(files, fakeRead(content), 'target', {
      baseDir: '/p',
      include: '**/*.ts',
    });

    assert.equal(result.totalMatches, 2);
    assert.equal(result.results.length, 2);
  });

  test('maxMatches 截断：truncated=true，totalMatches 含未收集部分', async () => {
    const files = ['/p/a.txt'];
    // 10 行全命中，maxMatches=3
    const lines = Array.from({ length: 10 }, (_, i) => `hit-${i}`);
    const content = new Map([['/p/a.txt', lines.join('\n')]]);

    const result = await matchInFiles(files, fakeRead(content), 'hit', {
      baseDir: '/p',
      maxMatches: 3,
    });

    assert.equal(result.truncated, true);
    assert.equal(result.results.length, 3);
    assert.equal(result.totalMatches, 10);
    // 前 3 条正确
    assert.equal(result.results[0].line, 1);
    assert.equal(result.results[2].line, 3);
  });

  test('不可读文件跳过（read 抛错）不炸，其余正常匹配', async () => {
    const files = ['/p/good.ts', '/p/bad.ts', '/p/also-good.ts'];
    const content = new Map([
      ['/p/good.ts', 'find-me'],
      // bad.ts 不在 map → fakeRead 抛 ENOENT
      ['/p/also-good.ts', 'find-me-too'],
    ]);

    const result = await matchInFiles(files, fakeRead(content), 'find-me', { baseDir: '/p' });

    assert.equal(result.totalMatches, 2);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].path, 'good.ts');
    assert.equal(result.results[1].path, 'also-good.ts');
  });

  test('text 截断至 500 字符', async () => {
    const longLine = 'x'.repeat(800);
    const files = ['/p/long.txt'];
    const content = new Map([['/p/long.txt', longLine]]);

    const result = await matchInFiles(files, fakeRead(content), 'x', { baseDir: '/p' });

    assert.equal(result.results[0].text.length, 500);
  });

  test('零匹配：空结果', async () => {
    const files = ['/p/a.ts'];
    const content = new Map([['/p/a.ts', 'nothing']]);

    const result = await matchInFiles(files, fakeRead(content), 'zzz', { baseDir: '/p' });

    assert.deepEqual(result, { results: [], totalMatches: 0, truncated: false });
  });

  test('空文件列表：空结果', async () => {
    const result = await matchInFiles([], fakeRead(new Map()), 'anything', { baseDir: '/p' });
    assert.deepEqual(result, { results: [], totalMatches: 0, truncated: false });
  });

  test('默认 maxMatches=200', async () => {
    // 构造 250 行全命中
    const lines = Array.from({ length: 250 }, (_, i) => `line-${i}-hit`);
    const files = ['/p/big.txt'];
    const content = new Map([['/p/big.txt', lines.join('\n')]]);

    const result = await matchInFiles(files, fakeRead(content), 'hit', { baseDir: '/p' });

    assert.equal(result.truncated, true);
    assert.equal(result.results.length, 200);
    assert.equal(result.totalMatches, 250);
  });
});

describe('#60 createGrep 端到端行为不变（锁定公共 API）', () => {
  test('非法正则抛友好错误', async () => {
    await assert.rejects(
      () => createGrep('[invalid', '/tmp'),
      (err) => {
        assert.ok(err.message.includes('Invalid regular expression'));
        return true;
      },
    );
  });
});
