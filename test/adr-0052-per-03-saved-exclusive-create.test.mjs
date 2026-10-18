// ADR-0052 PER-03：saved 脚本落盘必须独占创建，撞名不许覆盖
//
// 旧路径是「查一下候选名在不在 → 挑个备用名 → 普通 writeFile 写下去」，检查与写入之间有一段缝：
// 并发保存同名但内容不同的脚本时，两个调用可能都判定同一个名字空闲，后者把前者刚写下的内容盖掉，
// 于是有一份来源凭空消失，而两条引用都指向同一份盘上内容。
//
// 这一份锁的是修好之后的行为：候选名逐独占创建，抢到即落盘；名字已被占住时，同内容算复用，
// 异内容换下一个候选名重试。断言全部落在盘上事实：每个来源都在自己的路径上、路径互不相同、
// revision 与内容对得上、预置文件一个字节都没被改写。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { persistScript, loadScript } from '../dist/workflows/saved.js';
import { workflowPaths } from '../dist/workflows/paths.js';

let TMP;

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-per03-'));
  TMP = dir;
  const workspaceDir = path.join(dir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { workspaceDir, paths: workflowPaths(path.join(workspaceDir, '.myterminal')) };
}

afterEach(() => {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

const revisionOf = (content) => createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
const SHARED_NAME = 'shared-pass';
const sharedSource = (tag) => `export const meta = { name: '${SHARED_NAME}' };\nconst tag = '${tag}';\nreturn tag;`;

/** 权限位断言：0600 是 POSIX 概念——Windows 没有模式位（Node 恒报 0o666，
 *  open 的 mode 参数被忽略），那里只断言文件可读；POSIX 上才钉 0600。 */
function assertScriptMode(file) {
  const mode = fs.statSync(file).mode & 0o777;
  if (process.platform === 'win32') {
    assert.ok((mode & 0o444) !== 0, `新建脚本必须可读: ${file}`);
  } else {
    assert.equal(mode, 0o600, `新建脚本必须是 0600: ${file}`);
  }
}

/** saved 根下真正落了盘的文件（只这一层，脚本名不带子目录）。 */
function savedFiles(paths) {
  if (!fs.existsSync(paths.savedRoot)) return [];
  return fs.readdirSync(paths.savedRoot).filter((entry) => entry.endsWith('.js')).sort();
}

// ── 并发同名不同内容：一份都不许丢 ─────────────────────────────

test('PER-03 并发同名不同内容：每份来源都留在自己的路径上，无人被覆盖', async () => {
  const { paths } = temp();
  const sources = Array.from({ length: 20 }, (_, i) => sharedSource(`run-${String(i).padStart(2, '0')}`));
  const fallbacks = sources.map((_, i) => `wf_run_${String(i).padStart(2, '0')}`);

  const saved = await Promise.all(sources.map((source, i) => persistScript(paths, source, fallbacks[i])));

  // 返回值自带的内容与引用自洽。
  saved.forEach((result, i) => {
    assert.equal(result.content, sources[i]);
    assert.equal(result.sourceRef.revision, revisionOf(sources[i]), 'revision 必须匹配返回的内容');
    assert.equal(result.sourceRef.id, `${result.name}.js`);
    assert.equal(result.path, path.join(paths.savedRoot, `${result.name}.js`));
  });

  // 路径互不相同——并发调用不许指向同一个文件。
  const targets = saved.map((result) => result.path);
  assert.equal(new Set(targets).size, sources.length, '每个来源都要有自己的路径');

  // 盘上真相：每个来源都完整落在它自己声明的那条路径上。
  saved.forEach((result, i) => {
    assert.equal(fs.readFileSync(result.path, 'utf8'), sources[i], `路径 ${result.path} 上的内容必须是第 ${i} 份来源`);
  });

  // 一份来源都没丢、也没有两份挤在同一份内容上。
  const contentsOnDisk = targets.map((target) => fs.readFileSync(target, 'utf8')).sort();
  assert.deepEqual(contentsOnDisk, [...sources].sort(), '20 份不同内容都要在盘上留下各自的一份');

  // 共享的 meta 名只归一个赢家，其余退到各自的 runId 命名。
  const names = savedFiles(paths);
  assert.equal(names.length, sources.length, '恰好 20 个文件，不多不少');
  assert.equal(names.filter((name) => name === `${SHARED_NAME}.js`).length, 1, 'meta 名只有一个赢家');
  assert.equal(saved.filter((result) => result.name === SHARED_NAME).length, 1);
  assert.equal(new Set(saved.map((result) => result.name)).size, sources.length, '名字也必须唯一');

  // 落盘权限位（POSIX 0600 / Windows 无可断言位，见 assertScriptMode），
  // 且每条脚本都能按引用读回自己的内容。
  saved.forEach((result) => {
    assertScriptMode(result.path);
  });
  for (let i = 0; i < saved.length; i += 1) {
    const loaded = await loadScript(paths, saved[i].path);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.content, sources[i]);
    assert.equal(loaded.sourceRef.revision, revisionOf(sources[i]));
  }
});

// ── 并发同内容：已有文件照样复用，绝不写坏 ─────────────────────

test('PER-03 并发同内容打到已有文件：全部复用同一路径，不多写一份', async () => {
  const { paths } = temp();
  const source = sharedSource('identical');
  // 先落一份，后续 12 路并发都只能撞上这个已完整写好的文件。
  const first = await persistScript(paths, source, 'wf_seed');
  assert.equal(first.name, SHARED_NAME);

  const saved = await Promise.all(
    Array.from({ length: 12 }, (_, i) => persistScript(paths, source, `wf_same_${String(i).padStart(2, '0')}`)),
  );

  assert.equal(new Set(saved.map((result) => result.path)).size, 1, '同内容并发必须收敛到同一个文件');
  assert.equal(saved[0].path, first.path, '复用的就是已有的那个文件');
  assert.deepEqual(savedFiles(paths), [`${SHARED_NAME}.js`], '复用不许再多写一份');
  assert.equal(fs.readFileSync(first.path, 'utf8'), source);
  saved.forEach((result) => {
    assert.equal(result.sourceRef.id, first.sourceRef.id);
    assert.equal(result.sourceRef.revision, first.sourceRef.revision);
  });
});

test('PER-03 并发同内容从空根起跑：每条返回路径内容都对，没有半截文件', async () => {
  const { paths } = temp();
  const source = sharedSource('identical-fresh');
  const saved = await Promise.all(
    Array.from({ length: 12 }, (_, i) => persistScript(paths, source, `wf_fresh_${String(i).padStart(2, '0')}`)),
  );

  // 空根起跑时谁先拿到 meta 名取决于调度，落几个文件不作契约；
  // 真正的契约是：每条返回的路径上都必须是完整的同一份内容，谁也不许写坏、写丢。
  saved.forEach((result) => {
    assert.equal(fs.readFileSync(result.path, 'utf8'), source, `路径 ${result.path} 必须是完整内容`);
    assert.equal(result.sourceRef.revision, revisionOf(source));
    assertScriptMode(result.path);
  });
  const files = savedFiles(paths);
  assert.ok(files.length >= 1 && files.length <= saved.length, '文件数不会超过并发份数');
  files.forEach((name) => assert.equal(fs.readFileSync(path.join(paths.savedRoot, name), 'utf8'), source));
});

// ── 已有文件：同内容复用、异内容不覆盖 ─────────────────────────

test('PER-03 已有同名文件：同内容复用原路径，异内容另起一名且原文不动', async () => {
  const { paths } = temp();
  const source = sharedSource('kept');
  const first = await persistScript(paths, source, 'wf_first');
  assert.equal(first.name, SHARED_NAME);

  // 同内容再存一次（换一个 fallbackName）：复用已有文件，不新增。
  const again = await persistScript(paths, source, 'wf_second');
  assert.equal(again.path, first.path, '同内容必须复用原路径');
  assert.equal(again.sourceRef.id, first.sourceRef.id);
  assert.equal(again.sourceRef.revision, first.sourceRef.revision);
  assert.deepEqual(savedFiles(paths), [`${SHARED_NAME}.js`], '复用不许再多写一份');

  // 异内容：换名落盘，原文件一个字节都不改。
  const other = sharedSource('other');
  const second = await persistScript(paths, other, 'wf_second');
  assert.notEqual(second.path, first.path);
  assert.equal(second.name, 'wf_second');
  assert.equal(fs.readFileSync(first.path, 'utf8'), source, '已有脚本不许被覆盖');
  assert.equal(fs.readFileSync(second.path, 'utf8'), other);
  assert.equal(second.sourceRef.revision, revisionOf(other));
  assert.deepEqual(savedFiles(paths), [`${SHARED_NAME}.js`, 'wf_second.js']);
});

// ── 预置占位文件：并发保存只能绕开，不能改写 ───────────────────

test('PER-03 预置候选名占位：并发保存全部绕开，占位内容原样保留', async () => {
  const { paths } = temp();
  fs.mkdirSync(paths.savedRoot, { recursive: true });
  const planted = new Map([
    [`${SHARED_NAME}.js`, 'placeholder meta\n'],
    ['wf_run_00.js', 'placeholder 00\n'],
    ['wf_run_00-2.js', 'placeholder 00-2\n'],
    ['wf_run_01.js', 'placeholder 01\n'],
  ]);
  for (const [name, content] of planted) {
    fs.writeFileSync(path.join(paths.savedRoot, name), content, { mode: 0o600 });
  }

  // 第一份与 wf_run_00 的候选名 1、2、3 全被占住；其余同样要绕过占位。
  const sources = [sharedSource('A'), sharedSource('B'), sharedSource('C')];
  const saved = await Promise.all([
    persistScript(paths, sources[0], 'wf_run_00'),
    persistScript(paths, sources[1], 'wf_run_01'),
    persistScript(paths, sources[2], 'wf_run_02'),
  ]);

  saved.forEach((result, i) => {
    assert.equal(fs.readFileSync(result.path, 'utf8'), sources[i]);
  });
  assert.equal(new Set(saved.map((result) => result.path)).size, sources.length);

  // 占位文件一个都没被改写，也没被当成复用目标。
  for (const [name, content] of planted) {
    const target = path.join(paths.savedRoot, name);
    assert.equal(fs.readFileSync(target, 'utf8'), content, `占位文件 ${name} 被改写了`);
    assert.ok(!saved.some((result) => result.path === target), `占位文件 ${name} 被当成了复用目标`);
  }

  // 被占住的候选名不会让保存失败：每份来源都在占位之外找到了自己的位置。
  assert.equal(savedFiles(paths).length, planted.size + sources.length);
});

// ── 第二波重跑：路径稳定、不膨胀 ───────────────────────────────

test('PER-03 重跑同一批来源：复认已有路径，不再多写文件', async () => {
  const { paths } = temp();
  const sources = Array.from({ length: 8 }, (_, i) => sharedSource(`wave-${i}`));
  const fallbacks = sources.map((_, i) => `wf_wave_${i}`);

  const wave1 = await Promise.all(sources.map((source, i) => persistScript(paths, source, fallbacks[i])));
  const filesAfterWave1 = savedFiles(paths);
  assert.equal(filesAfterWave1.length, sources.length, '第一波恰好落 8 个文件');

  // 第二波沿用同一批 fallbackName：候选名序一致，就该逐条复认第一波的路径。
  const wave2 = await Promise.all(sources.map((source, i) => persistScript(paths, source, fallbacks[i])));

  assert.deepEqual(wave2.map((result) => result.path).sort(), wave1.map((result) => result.path).sort(), '重跑必须复认原路径');
  assert.deepEqual(savedFiles(paths), filesAfterWave1, '重跑不许再多写文件');
  wave2.forEach((result, i) => {
    assert.equal(fs.readFileSync(result.path, 'utf8'), sources[i]);
    assert.equal(result.sourceRef.revision, revisionOf(sources[i]));
  });
});
