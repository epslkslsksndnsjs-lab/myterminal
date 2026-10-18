// Workflows T1（#224）安全补丁：saved 脚本的路径约束按真身判定
//
// 词法白名单挡得住 `../`，挡不住「界内的 symlink 指向界外」：saved/x.js -> /etc/passwd
// 词法看干干净净，真身已经在根外。这一份锁的就是这条逃逸路——读与写都必须核真身，
// 同时不许把「根内、链接、但真身仍在根内」的正常脚本一起打死。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { persistScript, loadScript } from '../dist/workflows/saved.js';
import { workflowPaths, isInsideSavedRoot, resolveInsideSavedRoot } from '../dist/workflows/paths.js';

let TMP;

function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-224c-'));
  TMP = dir;
  const workspaceDir = path.join(dir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  return { workspaceDir, outside, paths: workflowPaths(path.join(workspaceDir, '.myterminal')) };
}

afterEach(() => {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } TMP = undefined; }
});

// ── 根内普通路径：真身判定不许误伤 ─────────────────────────────

test('saved 根内普通路径照常读写：真身判定不误伤正常脚本', async () => {
  const { paths } = temp();
  const source = `export const meta = { name: 'plain' };\nreturn 1;`;
  const saved = await persistScript(paths, source, 'wf_plain');
  assert.equal(saved.path, path.join(paths.savedRoot, 'plain.js'), '词法路径仍是对外身份');
  assert.equal(fs.readFileSync(saved.path, 'utf8'), source);

  const loaded = await loadScript(paths, saved.path);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.content, source);
  assert.equal(loaded.path, saved.path);
  assert.equal(loaded.sourceRef.id, 'plain.js');
  assert.equal(loaded.sourceRef.revision, saved.sourceRef.revision);

  // 根自身也按真身算在界内（resolveInsideSavedRoot 与 isInsideSavedRoot 同口径）
  assert.equal(isInsideSavedRoot(paths, saved.path), true);
  // 期望值必须走与 canonicalForm 相同的 realpath API（fs.promises.realpath）：
  // Windows 上 realpathSync 不展开 8.3 短名（RUNNER~1 原样返回），而
  // fs.promises.realpath 会展开成 runneradmin——混用两种 API 会让期望值算错。
  assert.equal(await resolveInsideSavedRoot(paths, saved.path), await fs.promises.realpath(saved.path));
  // 不存在的普通新文件名：根内 → 给出可写的真身
  const fresh = path.join(paths.savedRoot, 'not-yet.js');
  assert.equal(await resolveInsideSavedRoot(paths, fresh), path.join(await fs.promises.realpath(paths.savedRoot), 'not-yet.js'));
});

test('saved 根目录自身指向根外时拒绝读写', async () => {
  const { paths, outside } = temp();
  fs.mkdirSync(path.dirname(paths.savedRoot), { recursive: true });
  fs.symlinkSync(outside, paths.savedRoot, 'dir');
  const victim = path.join(outside, 'wf_root_escape.js');
  fs.writeFileSync(victim, 'untouched');

  await assert.rejects(
    () => persistScript(paths, 'return 1;', 'wf_root_escape'),
    /not inside the saved root/,
  );
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
  assert.deepEqual(await loadScript(paths, victim), { ok: false, reason: 'outside-root' });
});

// 整根换成链接、但真身落在 workflowsRoot 自身上：包含式判定的另一条缝隙。
test('saved 根被换成指向 workflowsRoot 自身的链接：真身相等不算界内，读写一律拒', async () => {
  const { paths } = temp();
  fs.mkdirSync(paths.workflowsRoot, { recursive: true });
  fs.writeFileSync(paths.registryFile, '{"runs":[]}');
  fs.symlinkSync(paths.workflowsRoot, paths.savedRoot, 'dir');

  // 不拦的话 saved 域塌成整个 workflows 域：registry.json 会被当作根内脚本读出来
  const viaSaved = path.join(paths.savedRoot, 'registry.json');
  assert.equal(isInsideSavedRoot(paths, viaSaved), true, '词法上确实在根内');
  assert.equal(await resolveInsideSavedRoot(paths, viaSaved), undefined);
  assert.deepEqual(await loadScript(paths, viaSaved), { ok: false, reason: 'outside-root' });
  assert.equal(fs.readFileSync(paths.registryFile, 'utf8'), '{"runs":[]}', 'registry 未被改动');

  await assert.rejects(
    () => persistScript(paths, 'return 1;', 'wf_collapse'),
    /not inside the saved root/,
  );
  assert.equal(fs.existsSync(path.join(paths.workflowsRoot, 'wf_collapse.js')), false, 'workflows 根内不许被写出脚本');
});

// 回归（SEC-02 残留副作用）：mkdir 曾排在真身判定之前。workflowsRoot 是指向界外的链接时，
// 判定虽然照旧拒写，可 saved 目录已经在根外真被造出来了——拒是拒了，副作用留下了。
test('workflowsRoot 指向根外：persistScript 拒写，且不在根外造出 saved 目录', async () => {
  const { paths, outside } = temp();
  fs.mkdirSync(paths.managedRoot, { recursive: true });
  const escapedWorkflows = path.join(outside, 'workflows');
  fs.mkdirSync(escapedWorkflows, { recursive: true });
  fs.symlinkSync(escapedWorkflows, paths.workflowsRoot, 'dir');
  const escapedSaved = path.join(escapedWorkflows, 'saved');
  assert.equal(fs.existsSync(escapedSaved), false, '前置：根外本来没有 saved 目录');

  await assert.rejects(
    () => persistScript(paths, 'return 1;', 'wf_link_escape'),
    /not inside the saved root/,
  );
  assert.equal(fs.existsSync(escapedSaved), false, '拒写必须发生在 mkdir 之前：根外不许被造出 saved 目录');
  assert.deepEqual(fs.readdirSync(escapedWorkflows), [], '根外目录保持原样，一个文件都不许多');
});

test('saved 根自身经 symlink 表示时仍认作同一根（两端同求真身）', async () => {
  const { workspaceDir } = temp();
  const linkedWorkspace = path.join(TMP, 'ws-link');
  fs.symlinkSync(workspaceDir, linkedWorkspace);
  // paths.savedRoot 走链接形态，实际落盘在 workspaceDir 下
  const paths = workflowPaths(path.join(linkedWorkspace, '.myterminal'));

  const source = `return 7;`;
  const saved = await persistScript(paths, source, 'wf_linked_root');
  assert.equal(saved.path, path.join(paths.savedRoot, 'wf_linked_root.js'));
  assert.equal(fs.existsSync(path.join(workspaceDir, '.myterminal', 'workflows', 'saved', 'wf_linked_root.js')), true);

  const loaded = await loadScript(paths, saved.path);
  assert.equal(loaded.ok, true, '根形态不同不算越界');
  assert.equal(loaded.content, source);
});

// ── 链接路径：真身落在根外一律拒 ───────────────────────────────

test('saved 根内文件链接到根外：loadScript 拒，内容不外泄', async () => {
  const { paths, outside } = temp();
  fs.mkdirSync(paths.savedRoot, { recursive: true });
  const secret = path.join(outside, 'secret.js');
  fs.writeFileSync(secret, 'return "host-secret";');
  const link = path.join(paths.savedRoot, 'leak.js');
  fs.symlinkSync(secret, link);

  assert.equal(isInsideSavedRoot(paths, link), true, '词法上确实在根内');
  assert.deepEqual(await loadScript(paths, link), { ok: false, reason: 'outside-root' });
  assert.equal(await resolveInsideSavedRoot(paths, link), undefined);
});

test('saved 根内目录链接到根外：其下的脚本读不到', async () => {
  const { paths, outside } = temp();
  fs.mkdirSync(paths.savedRoot, { recursive: true });
  fs.mkdirSync(path.join(outside, 'nested'));
  fs.writeFileSync(path.join(outside, 'nested', 'x.js'), 'return "host-secret";');
  fs.symlinkSync(path.join(outside, 'nested'), path.join(paths.savedRoot, 'nested'));

  assert.deepEqual(await loadScript(paths, path.join(paths.savedRoot, 'nested', 'x.js')), { ok: false, reason: 'outside-root' });
});

test('saved 根内链接指向根内：仍可读（链接不是原罪，越界才是）', async () => {
  const { paths } = temp();
  const source = `return 42;`;
  const saved = await persistScript(paths, source, 'wf_target');
  const alias = path.join(paths.savedRoot, 'alias.js');
  fs.symlinkSync(saved.path, alias);

  const loaded = await loadScript(paths, alias);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.content, source);
  assert.equal(loaded.sourceRef.id, 'alias.js', 'id 仍按调用者给的词法路径算');
  // 同 line 50 的口径注释：期望值与 canonicalForm 同走 fs.promises.realpath，
  // Windows 上 realpathSync 不展开 8.3 短名，混用会让期望值算错。
  assert.equal(await resolveInsideSavedRoot(paths, alias), await fs.promises.realpath(saved.path));
});

test('saved 写目标被链接到根外：persistScript 拒写，根外文件一动不动', async () => {
  const { paths, outside } = temp();
  fs.mkdirSync(paths.savedRoot, { recursive: true });
  const victim = path.join(outside, 'victim.js');
  fs.writeFileSync(victim, 'untouched');
  // 落名与 fallbackName 撞车：不核真身就会顺着链接写出去
  fs.symlinkSync(victim, path.join(paths.savedRoot, 'wf_victim.js'));

  await assert.rejects(
    () => persistScript(paths, 'return 1;', 'wf_victim'),
    /not inside the saved root/,
  );
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
});

test('saved 写目标是悬空链接：不顺着链接在根外造出文件', async () => {
  const { paths, outside } = temp();
  fs.mkdirSync(paths.savedRoot, { recursive: true });
  const planted = path.join(outside, 'planted.js');
  fs.symlinkSync(planted, path.join(paths.savedRoot, 'wf_dangle.js'));

  await assert.rejects(
    () => persistScript(paths, 'return 2;', 'wf_dangle'),
    /not inside the saved root/,
  );
  assert.equal(fs.existsSync(planted), false, '根外不许被凭空造出文件');
  // 同一根内的正常写入不受影响
  const ok = await persistScript(paths, 'return 3;', 'wf_after');
  assert.equal(fs.readFileSync(ok.path, 'utf8'), 'return 3;');
});

test('词法越界仍按旧口径拒：`../` 与根前缀兄弟目录都不进真身判定', async () => {
  const { paths, outside } = temp();
  fs.mkdirSync(paths.savedRoot, { recursive: true });
  fs.writeFileSync(path.join(outside, 'up.js'), 'return "host-secret";');

  assert.deepEqual(await loadScript(paths, path.join(paths.savedRoot, '..', '..', 'up.js')), { ok: false, reason: 'outside-root' });
  assert.deepEqual(await loadScript(paths, path.join(outside, 'up.js')), { ok: false, reason: 'outside-root' });
  assert.deepEqual(await loadScript(paths, `${paths.savedRoot}-evil/x.js`), { ok: false, reason: 'outside-root' });
  // 根内不存在的普通文件仍是 not-found，不跟着降级成 outside-root
  assert.deepEqual(await loadScript(paths, path.join(paths.savedRoot, 'ghost.js')), { ok: false, reason: 'not-found' });
});
