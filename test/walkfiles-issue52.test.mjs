// #52（批4 / ADR-0031 / G9）walkFiles 单源 + IGNORE 规则收敛回归
// 证明 walkFiles 与 IGNORE_DIRECTORIES 已收敛为单一实现 / 单一真相源：
//   - IGNORE_DIRECTORIES 为单源 9 项超集（含 core-tools 原缺失的 build/.cache —— 即漂移修复）
//   - walkFiles 返回绝对路径、跳过全部 IGNORE 目录、对缺失/不可读目录鲁棒（跳过不抛）
//   - limit 截断生效
// 本测试是 G9 红灯：模块落地前 import 失败（红），落地后转绿。批5 #60 的地基。

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';

import { walkFiles, IGNORE_DIRECTORIES } from '../dist/utils/fs.js';

const IGNORE_GOLDEN = ['.git', '.myterminal', 'node_modules', 'dist', 'coverage', '.next', '.turbo', 'build', '.cache'];

describe('#52 walkFiles 单源收敛', () => {
  test('IGNORE_DIRECTORIES 为单源 9 项超集，含 build/.cache（修复 core-tools 漂移）', async () => {
    assert.equal(IGNORE_DIRECTORIES.size, 9, 'IGNORE 应为 9 项收敛集合');
    for (const d of IGNORE_GOLDEN) {
      assert.ok(IGNORE_DIRECTORIES.has(d), `IGNORE_DIRECTORIES 应包含 ${d}`);
    }
  });

  test('walkFiles 返回绝对路径并跳过所有 IGNORE 目录', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mt-walk-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), '');
    mkdirSync(join(root, 'lib', 'sub'), { recursive: true });
    writeFileSync(join(root, 'lib', 'b.ts'), '');
    writeFileSync(join(root, 'lib', 'sub', 'a.ts'), '');

    // 这些目录必须被忽略（core-tools 原 7 项集合会漏掉 build/.cache）
    for (const ig of ['.git', 'node_modules', 'build', '.cache', 'dist', 'coverage', '.next', '.turbo', '.myterminal']) {
      mkdirSync(join(root, ig, 'deep'), { recursive: true });
      writeFileSync(join(root, ig, 'deep', 'leak.txt'), '');
    }

    const files = await walkFiles(root);
    for (const f of files) assert.ok(isAbsolute(f), `walkFiles 必须返回绝对路径，得到: ${f}`);

    const rels = files.map((f) => relative(root, f).replace(/\\/g, '/'));
    for (const ig of ['.git', 'node_modules', 'build', '.cache', 'dist']) {
      assert.ok(
        !rels.some((r) => r === ig || r.startsWith(ig + '/')),
        `IGNORE 目录 ${ig} 不应出现在遍历结果中`,
      );
    }
    assert.ok(rels.includes('src/index.ts'), '普通文件 src/index.ts 应被遍历');
    assert.ok(rels.includes('lib/b.ts'), '普通文件 lib/b.ts 应被遍历');
    assert.ok(rels.includes('lib/sub/a.ts'), '嵌套文件 lib/sub/a.ts 应被遍历');
  });

  test('walkFiles 对缺失/不可读根目录鲁棒（跳过不抛）', async () => {
    const missing = join(tmpdir(), 'mt-walk-missing-', String(Date.now()));
    assert.deepEqual(await walkFiles(missing), [], '缺失目录应返回空数组而非抛错');
  });

  test('walkFiles limit 截断生效', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mt-walk-lim-'));
    mkdirSync(join(root, 'd'), { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(root, 'd', `f${i}.ts`), '');

    const files = await walkFiles(root, { limit: 2 });
    assert.ok(files.length <= 2, `limit=2 时结果不应超 2，得到 ${files.length}`);
  });
});
