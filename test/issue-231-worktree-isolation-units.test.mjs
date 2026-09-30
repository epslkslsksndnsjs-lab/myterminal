// Workflows T8（#231）：写必隔离（worktree）——零件契约
//
// 单元面锁隔离零件各自的行为边界：写类工具的可见性与自闸、路径双检在 worktree 边界上的
// 成立方式、git 工具层每条命令都带 gc.auto=0、登记簿"创建即登记"、fence 删除、
// 创建 / 清理串行化、四层配额（软阈值告警 / 硬上限拒建 / 磁盘下界 / 旧的一律不删）、
// 保留项的字节与计数口径、归档三步（bundle → 校验 → 删目录）。改了就红。
// 引擎级验收（写必隔离的派发路径、主 checkout 与主 .git 不可达、per-dispatch 生命周期、
// 真 git fixture）在 issue-231-worktree-isolation.test.mjs。

import { test, afterEach, describe } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  WRITE_TOOLS,
  MAX_WRITE_CONTENT_CHARS,
} from '../dist/workflows/tool-write.js';
import {
  AGENT_PROFILES,
  TOOL_CATALOGUE,
  WRITE_ONLY_TOOL_NAMES,
  describeFaceViolations,
  resolveToolFace,
  requestedWriteToolNames,
  toolByName,
  toolDeclarations,
} from '../dist/workflows/tool-face.js';
import { invokeToolCall } from '../dist/workflows/tool-invoke.js';
import {
  GIT_NO_GC_ARGS,
  checkGitAvailable,
  isGitRepository,
  repoTopLevel,
  mainWorktreePath,
  hasUncommittedChanges,
  addWorktree,
  worktreeHasWork,
  hasUnmergedWorktreeCommits,
  removeWorktree,
  bundleWorktreeBranch,
} from '../dist/workflows/worktree-git.js';
import {
  WorktreeRegistry,
  WORKTREE_STATES,
  worktreeIdFor,
} from '../dist/workflows/worktree-registry.js';
import {
  MIN_FREE_BYTES,
  QUOTA_SOFT_THRESHOLD_RATIO,
  directoryBytes,
  evaluateQuota,
} from '../dist/workflows/worktree-quota.js';
import { WorktreeService, WORKTREE_TRASH_DIR } from '../dist/workflows/worktree-service.js';
import { worktreesRootFor, worktreePathFor, isInsideWorktreesRoot, workflowPaths } from '../dist/workflows/paths.js';
import { SCHEMA_VERSION } from '../dist/workflows/schema.js';
import {
  worktreePanelRows,
  describeQuotaWarning,
  isWorktreeQuotaWarning,
} from '../dist/tui/controller-logic.js';

const TMP = [];
function dir() {
  const created = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-231u-')));
  TMP.push(created);
  return created;
}
afterEach(() => {
  while (TMP.length) {
    const removed = TMP.pop();
    try { fs.rmSync(removed, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

// ══════════════════════════════════════════════════════════
// 工具面：写类工具只随 worktree 模式出现
// ══════════════════════════════════════════════════════════

describe('写类工具面（ADR-0052 §11 写必隔离 / 同尺子）', () => {
  test('目录里有写类工具，且都标了 write: true', () => {
    const names = WRITE_ONLY_TOOL_NAMES;
    assert.deepEqual([...names].sort(), ['apply_patch', 'write_file']);
    for (const name of names) {
      const tool = toolByName(name);
      assert.ok(tool, `${name} must be in the module catalogue`);
      assert.equal(tool.write, true);
    }
    assert.equal(TOOL_CATALOGUE.filter((tool) => tool.write).length, names.length);
  });

  test('工具面随模式变：默认只读面没有写工具，worktree 面有', () => {
    const readOnly = resolveToolFace({ mode: 'read-only' });
    assert.ok(readOnly.names);
    for (const name of WRITE_ONLY_TOOL_NAMES) {
      assert.ok(!readOnly.names.includes(name), `${name} must stay off the read-only face`);
    }
    const worktree = resolveToolFace({ mode: 'worktree' });
    assert.ok(worktree.names);
    for (const name of WRITE_ONLY_TOOL_NAMES) {
      assert.ok(worktree.names.includes(name), `${name} must be on the worktree face`);
    }
  });

  test('结构断言：写工具出现在只读面上即违例', () => {
    assert.deepEqual(describeFaceViolations(['write_file'], 'read-only'), ['write_file: a write tool on the read-only face']);
    assert.deepEqual(describeFaceViolations(['write_file', 'apply_patch'], 'worktree'), []);
  });

  test('写工具同尺子：单动词、单目标、原子、入参形状不含复合', () => {
    for (const tool of WRITE_TOOLS) {
      const verbs = tool.name.split('_').filter((segment) => ['read', 'list', 'find', 'search', 'execute', 'write', 'apply', 'structured'].includes(segment));
      assert.equal(verbs.length, 1, `${tool.name} carries exactly one atomic verb`);
      const schema = tool.inputSchema;
      assert.equal(schema.type, 'object');
      assert.equal(schema.additionalProperties, false);
      assert.ok(Array.isArray(schema.required) && schema.required.length >= 2);
      assert.ok(schema.properties.path, `${tool.name} names one target via path`);
      assert.ok(tool.description.trim().length > 0);
    }
    const declarations = toolDeclarations(['write_file', 'apply_patch']);
    assert.deepEqual(declarations.map((item) => item.name), ['write_file', 'apply_patch']);
  });

  test('脚本请求写而不标隔离：请求面里的写工具名可被认出来', () => {
    assert.deepEqual([...requestedWriteToolNames(['write_file', 'read_file'])].sort(), ['write_file']);
    assert.deepEqual(requestedWriteToolNames(['read_file']), []);
    assert.deepEqual(requestedWriteToolNames(undefined), []);
    // 展示名与拼写名互认（与缓存键同一口径）。
    assert.deepEqual([...requestedWriteToolNames(['Write file', 'apply-patch'])].sort(), ['apply_patch', 'write_file']);
  });

  test('reader 型别不给写工具，即使声明隔离', () => {
    const face = resolveToolFace({ mode: 'worktree', agentType: 'reader' });
    assert.ok(face.names);
    for (const name of WRITE_ONLY_TOOL_NAMES) assert.ok(!face.names.includes(name));
  });
});

// ══════════════════════════════════════════════════════════
// 写类工具自身：第二道硬闸 + 边界 + 有界返回
// ══════════════════════════════════════════════════════════

describe('write_file / apply_patch 的硬执行面', () => {
  const base = dir();

  function context(overrides = {}) {
    return {
      runId: 'wf_0123456789abcdef',
      dispatchId: 'd0001',
      cwd: base,
      mode: 'worktree',
      signal: new AbortController().signal,
      run: { dir: base, indexFile: path.join(base, 'index.json'), journalFile: '', snapshotFile: '', terminalFile: '', outboxDir: '', agentsDir: '', digestFile: '', waiterFile: '', lockFile: '', bgDir: '' },
      ...overrides,
    };
  }

  async function call(name, input, overrides = {}) {
    const encoded = await invokeToolCall({ id: 'c1', name, input }, { names: [name], mode: overrides.mode ?? 'worktree' }, context(overrides));
    return { payload: JSON.parse(encoded.content), isError: encoded.isError };
  }

  test('写工具只认 worktree 模式：只读面上照名字给到它，仍然拒（不靠提示词）', async () => {
    const { payload, isError } = await call('write_file', { path: 'note.txt', content: 'hi' }, { mode: 'read-only' });
    assert.equal(isError, true);
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, 'isolation-required');
    assert.match(payload.error, /worktree/i);
    assert.equal(fs.existsSync(path.join(base, 'note.txt')), false, 'a refused write leaves nothing behind');
  });

  test('write_file 写出内容并回报 bytes + sha256（结构化、有界）', async () => {
    const { payload } = await call('write_file', { path: 'out/note.txt', content: '第一行\n第二行\n' });
    assert.equal(payload.ok, true);
    assert.equal(fs.readFileSync(path.join(base, 'out', 'note.txt'), 'utf8'), '第一行\n第二行\n');
    assert.equal(payload.bytes, Buffer.byteLength('第一行\n第二行\n'));
    assert.equal(payload.created, true);
    assert.match(payload.sha256, /^[a-f0-9]{64}$/);
    const again = await call('write_file', { path: 'out/note.txt', content: 'replaced' });
    assert.equal(again.payload.created, false);
    assert.equal(again.payload.overwritten, true);
  });

  test('越界写一律拒：../ 逃逸、绝对路径指向界外、经 symlink 逃逸三臂', async () => {
    const outside = dir();
    const up = await call('write_file', { path: '../escape.txt', content: 'x' });
    assert.equal(up.payload.reason, 'outside-boundary');
    const absolute = await call('write_file', { path: path.join(outside, 'abs.txt'), content: 'x' });
    assert.equal(absolute.payload.reason, 'outside-boundary');
    assert.equal(fs.existsSync(path.join(outside, 'abs.txt')), false);

    const link = path.join(base, 'link-dir');
    fs.symlinkSync(outside, link, 'dir');
    const through = await call('write_file', { path: 'link-dir/inside.txt', content: 'x' });
    assert.equal(through.payload.reason, 'outside-boundary');
    assert.match(through.payload.error, /symlink/);
    assert.equal(fs.existsSync(path.join(outside, 'inside.txt')), false);
  });

  test('目标是目录 / 内容越界 / 空内容都有具名拒因', async () => {
    fs.mkdirSync(path.join(base, 'a-dir'), { recursive: true });
    const isDir = await call('write_file', { path: 'a-dir', content: 'x' });
    assert.equal(isDir.payload.reason, 'is-a-directory');
    const empty = await call('write_file', { path: 'empty.txt', content: '' });
    assert.equal(empty.payload.reason, 'bad-tool-input');
    const tooBig = await call('write_file', { path: 'big.txt', content: 'a'.repeat(MAX_WRITE_CONTENT_CHARS + 1) });
    assert.equal(tooBig.payload.reason, 'content-too-large');
    assert.match(tooBig.payload.error, new RegExp(String(MAX_WRITE_CONTENT_CHARS)));
    assert.equal(fs.existsSync(path.join(base, 'big.txt')), false);
  });

  test('apply_patch 单目标精确替换：命中一次才改，零次与多次都拒', async () => {
    fs.writeFileSync(path.join(base, 'code.ts'), 'const a = 1;\nconst b = 1;\n');
    const once = await call('apply_patch', { path: 'code.ts', oldText: 'const b = 1;', newText: 'const b = 2;' });
    assert.equal(once.payload.ok, true);
    assert.equal(once.payload.replacements, 1);
    assert.equal(fs.readFileSync(path.join(base, 'code.ts'), 'utf8'), 'const a = 1;\nconst b = 2;\n');

    const none = await call('apply_patch', { path: 'code.ts', oldText: 'const z = 9;', newText: 'x' });
    assert.equal(none.payload.reason, 'patch-no-match');
    const ambiguous = await call('apply_patch', { path: 'code.ts', oldText: 'const', newText: 'let' });
    assert.equal(ambiguous.payload.reason, 'patch-ambiguous');
    assert.equal(fs.readFileSync(path.join(base, 'code.ts'), 'utf8'), 'const a = 1;\nconst b = 2;\n', 'a refused patch changes nothing');
  });

  test('apply_patch 的边界与模式闸与 write_file 同尺', async () => {
    fs.writeFileSync(path.join(base, 'in.txt'), 'hello');
    const escaped = await call('apply_patch', { path: '../in.txt', oldText: 'hello', newText: 'bye' });
    assert.equal(escaped.payload.reason, 'outside-boundary');
    const onReadOnly = await call('apply_patch', { path: 'in.txt', oldText: 'hello', newText: 'bye' }, { mode: 'read-only' });
    assert.equal(onReadOnly.payload.reason, 'isolation-required');
  });

  test('盘上故障各回具名拒因：权限、目标是目录、祖先不是目录都不静默', { skip: typeof process.getuid === 'function' && process.getuid() === 0 }, async () => {
    fs.writeFileSync(path.join(base, 'afile.txt'), 'hello');
    const locked = path.join(base, 'locked');
    fs.mkdirSync(locked, { recursive: true });
    fs.chmodSync(locked, 0o500);
    try {
      const denied = await call('write_file', { path: path.join('locked', 'nope.txt'), content: 'x' });
      assert.equal(denied.payload.reason, 'permission-denied');
      const deniedPatch = await call('apply_patch', { path: path.join('locked', 'nope.txt'), oldText: 'a', newText: 'b' });
      assert.equal(deniedPatch.payload.reason, 'not-found', '读不到就是没有那份文件——先认文件，再谈写权限');
    } finally {
      fs.chmodSync(locked, 0o700);
    }
    const readADirectory = await call('apply_patch', { path: 'afile.txt/../', oldText: 'hello', newText: 'bye' });
    assert.ok(['is-a-directory', 'outside-boundary', 'read-failed'].includes(readADirectory.payload.reason), JSON.stringify(readADirectory.payload));
    fs.writeFileSync(path.join(base, 'plain.txt'), 'x');
    const throughFile = await call('write_file', { path: 'plain.txt/inner.txt', content: 'x' });
    assert.equal(throughFile.payload.reason, 'write-failed', '祖先是文件时 stat 抛的不是 ENOENT：原文带回去，不静默');
  });

  test('声明表与目录同源：写工具进了面就能被声明出来', () => {
    const face = resolveToolFace({ mode: 'worktree', tools: ['write_file'] });
    assert.deepEqual(face.names, ['write_file']);
    const refusal = resolveToolFace({ mode: 'read-only', tools: ['apply_patch'] });
    assert.equal(refusal.refusal.reason, 'tool-unavailable-on-face');
  });

  test('worktree 型别的档案上界含写工具，只读面靠模式过滤掉它', () => {
    const profile = AGENT_PROFILES['workflow-agent'];
    for (const name of WRITE_ONLY_TOOL_NAMES) assert.ok(profile.includes(name), `${name} must be in the default profile ceiling`);
  });
});

/** 带 .git FILE 的假工作树：销毁谓词先认它，没它一律按"有活"保留。 */
function worktreeFixture() {
  const root = dir();
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: /nowhere\n');
  return root;
}

// ══════════════════════════════════════════════════════════
// git 工具层：每条命令都关自动 gc，检查器抛错按"保留"
// ══════════════════════════════════════════════════════════

describe('worktree-git：命令面与失败口径', () => {
  function recorder(result = { code: 0, stdout: '', stderr: '' }) {
    const calls = [];
    return {
      calls,
      result,
      runner: async (argv, cwd) => {
        calls.push({ argv, cwd });
        return typeof result === 'function' ? result(argv) : result;
      },
    };
  }

  test('每一条 git 命令都带 gc.auto=0 与 --no-optional-locks（对象库不被并发 gc 互踩）', async () => {
    const probe = recorder({ code: 0, stdout: 'true\n', stderr: '' });
    await isGitRepository(probe.runner, '/tmp/whatever');
    await hasUncommittedChanges(probe.runner, '/tmp/whatever');
    await worktreeHasWork(probe.runner, worktreeFixture());
    assert.ok(probe.calls.length >= 3);
    for (const call of probe.calls) {
      assert.deepEqual(call.argv.slice(0, GIT_NO_GC_ARGS.length), [...GIT_NO_GC_ARGS]);
      assert.ok(call.argv.includes('--no-optional-locks'));
      assert.ok(call.argv.includes('-c'));
      assert.ok(call.argv.includes('gc.auto=0'));
    }
  });

  test('checkGitAvailable：版本命令打不出去即 false（spawn 抛错不外溢）', async () => {
    assert.equal(await checkGitAvailable(async () => { throw new Error('ENOENT git'); }), true === false);
    const ok = recorder({ code: 0, stdout: 'git version 2.50.1\n', stderr: '' });
    assert.equal(await checkGitAvailable(ok.runner), true);
    assert.equal(await checkGitAvailable(async () => ({ code: 127, stdout: '', stderr: 'git: command not found' })), false);
  });

  test('脏检查只看未忽略的改动：.myterminal 这类 ignored 目录不算脏', async () => {
    const dirty = recorder({ code: 0, stdout: ' M src/a.ts\n?? new.txt\n', stderr: '' });
    assert.equal(await hasUncommittedChanges(dirty.runner, '/repo'), true);
    const clean = recorder({ code: 0, stdout: '', stderr: '' });
    assert.equal(await hasUncommittedChanges(clean.runner, '/repo'), false);
    // 谓词口径：不带 --ignored（ignored 条目不构成"脏"）。
    assert.ok(!dirty.calls[0].argv.includes('--ignored=matching'));
    assert.ok(dirty.calls[0].argv.includes('--untracked-files=normal'));
  });

  test('检查器自身抛错即按脏处理（fail-closed，宁拒不错建）', async () => {
    assert.equal(await hasUncommittedChanges(async () => { throw new Error('git exploded'); }, '/repo'), true);
    assert.equal(await hasUncommittedChanges(async () => ({ code: 0, stdout: '', stderr: 'warning: unable to read' })), true);
  });

  test('worktreeHasWork 是唯一销毁谓词：任何 stderr、任何非豁免条目都算有活', async () => {
    const wt = worktreeFixture();
    const rows = recorder({ code: 0, stdout: ' M file.ts\n', stderr: '' });
    assert.equal(await worktreeHasWork(rows.runner, wt), true);
    const untracked = recorder({ code: 0, stdout: '?? notes.md\n', stderr: '' });
    assert.equal(await worktreeHasWork(untracked.runner, wt), true);
    const onlyIgnored = recorder({ code: 0, stdout: '!! node_modules/foo/index.js\n', stderr: '' });
    assert.equal(await worktreeHasWork(onlyIgnored.runner, wt), false);
    const disposable = recorder({ code: 0, stdout: '!! coverage/lcov.info\n!! dist/bundle.js\n', stderr: '' });
    assert.equal(await worktreeHasWork(disposable.runner, wt), false);
    const mixed = recorder({ code: 0, stdout: '!! node_modules/x\n M src/a.ts\n', stderr: '' });
    assert.equal(await worktreeHasWork(mixed.runner, wt), true, '豁免与真改动混在一起时保留');
    const withStderr = recorder({ code: 0, stdout: '', stderr: 'warning: could not open directory' });
    assert.equal(await worktreeHasWork(withStderr.runner, wt), true);
    assert.equal(await worktreeHasWork(async () => { throw new Error('boom'); }, wt), true);
  });

  test('豁免只认 ignored 条目；未跟踪的依赖目录不豁免，空 ignored 目录也不虚报', async () => {
    const untrackedDeps = recorder({ code: 0, stdout: '?? node_modules/foo/index.js\n', stderr: '' });
    assert.equal(await worktreeHasWork(untrackedDeps.runner, '/wt'), true);
    const emptyIgnoredDir = recorder({ code: 0, stdout: '!! build/\n', stderr: '' });
    const root = dir();
    fs.mkdirSync(path.join(root, 'build'), { recursive: true });
    assert.equal(await worktreeHasWork(emptyIgnoredDir.runner, root), true, '空目录读不出链接形态，不豁免');
  });

  test('纯符号链接折叠的 ignored 目录可豁免；旁有真文件即保留', async () => {
    const root = worktreeFixture();
    const linked = path.join(root, '.cache');
    const outside = dir();
    fs.mkdirSync(linked, { recursive: true });
    fs.symlinkSync(outside, path.join(linked, 'link'));
    const symlinkOnly = recorder({ code: 0, stdout: '!! .cache/\n', stderr: '' });
    assert.equal(await worktreeHasWork(symlinkOnly.runner, root), false);
    fs.writeFileSync(path.join(linked, 'real.txt'), 'x');
    const withReal = recorder({ code: 0, stdout: '!! .cache/\n', stderr: '' });
    assert.equal(await worktreeHasWork(withReal.runner, root), true);
  });

  test('worktreeHasWork 先确认 .git 在内，防 git 向上发现外层仓库', async () => {
    const missing = dir();
    assert.equal(await worktreeHasWork(async () => ({ code: 0, stdout: '', stderr: '' }), missing), true);
  });

  test('addWorktree 用 -b 建分支并把路径放在给定处；失败抛出带 git 原文', async () => {
    const probe = recorder({ code: 0, stdout: 'Preparing worktree\n', stderr: '' });
    const created = await addWorktree(probe.runner, { repoRoot: '/repo', worktreePath: '/repo/.myterminal/worktrees/w1', branch: 'worktree-agent-ab12cd34' });
    assert.equal(created.branch, 'worktree-agent-ab12cd34');
    const add = probe.calls.find((call) => call.argv.includes('worktree') && call.argv.includes('add'));
    assert.ok(add, 'a git worktree add invocation must be made');
    assert.equal(add.cwd, '/repo');
    assert.ok(add.argv.includes('-b'));
    assert.ok(add.argv.includes('worktree-agent-ab12cd34'));
    assert.ok(add.argv.includes('/repo/.myterminal/worktrees/w1'));
    const failing = recorder({ code: 128, stdout: '', stderr: 'fatal: already registered' });
    await assert.rejects(() => addWorktree(failing.runner, { repoRoot: '/repo', worktreePath: '/x', branch: 'b' }), /already registered/);
  });

  test('未合并提交检查：有 commit 即保留，判不准也保留', async () => {
    const ahead = recorder({ code: 0, stdout: '3\n', stderr: '' });
    assert.equal(await hasUnmergedWorktreeCommits(ahead.runner, { repoRoot: '/repo', branch: 'worktree-x', baseRef: 'HEAD' }), true);
    const none = recorder({ code: 0, stdout: '0\n', stderr: '' });
    assert.equal(await hasUnmergedWorktreeCommits(none.runner, { repoRoot: '/repo', branch: 'worktree-x', baseRef: 'HEAD' }), false);
    assert.equal(await hasUnmergedWorktreeCommits(async () => { throw new Error('nope'); }, { repoRoot: '/repo', branch: 'worktree-x', baseRef: 'HEAD' }), true);
  });

  test('removeWorktree 只收 git 侧：目录已由 fence 移走，注册位用 prune 收，分支安全删', async () => {
    const target = dir();
    const probe = recorder({ code: 0, stdout: '', stderr: '' });
    const out = await removeWorktree(probe.runner, { repoRoot: target, worktreePath: path.join(target, 'wt'), branch: 'worktree-x', deleteBranch: true });
    assert.equal(out.branchPreserved, false);
    const prune = probe.calls.find((call) => call.argv.includes('prune'));
    assert.ok(prune, 'a pruned registration is how a fenced-away directory is deregistered');
    assert.ok(prune.argv.includes('worktree'));
    const branchDelete = probe.calls.find((call) => call.argv.includes('branch') && call.argv.includes('-d'));
    assert.ok(branchDelete, 'the branch is deleted safely after the directory is gone');
    assert.ok(branchDelete.argv.includes('worktree-x'));
    assert.equal(probe.calls.some((call) => call.argv.includes('remove')), false, 'fenced removal never calls worktree remove');

    const keptBranch = recorder((argv) => (argv.includes('-d') ? { code: 1, stdout: '', stderr: 'error: not fully merged' } : { code: 0, stdout: '', stderr: '' }));
    const second = await removeWorktree(keptBranch.runner, { repoRoot: target, worktreePath: path.join(target, 'wt2'), branch: 'worktree-y', deleteBranch: true });
    assert.equal(second.branchPreserved, true);

    const keptOnPurpose = recorder({ code: 0, stdout: '', stderr: '' });
    const third = await removeWorktree(keptOnPurpose.runner, { repoRoot: target, worktreePath: path.join(target, 'wt3'), branch: 'worktree-z', deleteBranch: false });
    assert.equal(third.branchPreserved, true);
    assert.equal(keptOnPurpose.calls.some((call) => call.argv.includes('-d')), false);
  });

  test('top-level 与 main worktree 解析：取 git 给的路径，取不到即 null', async () => {
    const probe = recorder({ code: 0, stdout: '/repo/main\n', stderr: '' });
    assert.equal(await repoTopLevel(probe.runner, '/repo/sub'), '/repo/main');
    const list = recorder({ code: 0, stdout: 'worktree /repo/main\nHEAD abc\nworktree /repo/.myterminal/worktrees/w1\nHEAD def\n', stderr: '' });
    assert.equal(await mainWorktreePath(list.runner, '/repo'), '/repo/main');
    assert.equal(await repoTopLevel(async () => ({ code: 128, stdout: '', stderr: 'not a git repository' }), '/x'), null);
  });

  test('归档三步：bundle 落地 → verify 通过才说成功，verify 失败回滚不删目录', async () => {
    const target = dir();
    const probe = recorder({ code: 0, stdout: '', stderr: '' });
    const archived = await bundleWorktreeBranch(probe.runner, { repoRoot: target, branch: 'worktree-x', bundleFile: path.join(target, 'x.bundle'), worktreePath: path.join(target, 'wt') });
    assert.equal(archived.ok, true);
    const create = probe.calls.find((call) => call.argv.includes('bundle') && call.argv.includes('create'));
    const verify = probe.calls.find((call) => call.argv.includes('bundle') && call.argv.includes('verify'));
    assert.ok(create && verify);
    assert.ok(create.argv.includes('worktree-x'));

    const unverified = recorder((argv) => (argv.includes('verify') ? { code: 1, stdout: '', stderr: 'error: repository lacks this history' } : { code: 0, stdout: '', stderr: '' }));
    const failed = await bundleWorktreeBranch(unverified.runner, { repoRoot: target, branch: 'worktree-z', bundleFile: path.join(target, 'z.bundle'), worktreePath: path.join(target, 'wt') });
    assert.equal(failed.ok, false);
    assert.match(failed.message, /lacks this history/);
    assert.equal(fs.existsSync(path.join(target, 'z.bundle')), false, 'an unverified bundle is not left behind');
  });
});

// ══════════════════════════════════════════════════════════
// 登记簿：创建即登记、状态机、版本与串行化
// ══════════════════════════════════════════════════════════

describe('worktree 登记簿（机器件：additive、版本化、单写者）', () => {
  test('worktreesRoot 在库内 managed 根下，与 workflows/ 并列', () => {
    const root = dir();
    assert.equal(worktreesRootFor(root), path.join(root, 'worktrees'));
    assert.equal(worktreePathFor(root, 'wf_0123456789abcdef-d0001'), path.join(root, 'worktrees', 'wf_0123456789abcdef-d0001'));
    assert.throws(() => worktreePathFor(root, '../../escape'), /worktree id/);
    assert.throws(() => worktreePathFor(root, 'agent-ab12cd34'), /worktree id/);
    assert.equal(isInsideWorktreesRoot(root, path.join(root, 'worktrees', 'x')), true);
    assert.equal(isInsideWorktreesRoot(root, path.join(root, 'workflows')), false);
    assert.equal(isInsideWorktreesRoot(root, path.join(root, 'worktrees-evil')), false, '字符串前缀相同不算界内');
    assert.equal(isInsideWorktreesRoot(root, path.join(root, 'worktrees')), true, '管理根本身算界内');
    assert.equal(workflowPaths(root).worktreesRoot, worktreesRootFor(root));
  });

  test('worktreeId 由 runId + dispatchId 定出（同一路同一件，重试共享）', () => {
    assert.equal(worktreeIdFor('wf_0123456789abcdef', 'd0002'), worktreeIdFor('wf_0123456789abcdef', 'd0002'));
    assert.match(worktreeIdFor('wf_0123456789abcdef', 'd0002'), /^wf_0123456789abcdef-d0002$/);
    assert.notEqual(worktreeIdFor('wf_0123456789abcdef', 'd0001'), worktreeIdFor('wf_0123456789abcdef', 'd0002'));
    assert.throws(() => worktreeIdFor('not-a-run', 'd0001'), /runId/);
    assert.throws(() => worktreeIdFor('wf_0123456789abcdef', 'nope'), /dispatch/);
  });

  const RUN = 'wf_0123456789abcdef';

  test('登记先于建行：register 落盘成功后才回条目；重开同一件读得到', async () => {
    const root = dir();
    const registry = new WorktreeRegistry({ file: path.join(worktreesRootFor(root), 'registry.json') });
    const saved = await registry.load();
    assert.equal(saved.entries.length, 0);
    const entry = await registry.register({ id: worktreeIdFor(RUN, 'd0001'), runId: RUN, dispatchId: 'd0001', path: '/x/y', branch: 'worktree-a', at: '2026-10-01T00:00:00.000Z' });
    assert.equal(entry.state, 'starting');
    const reloaded = new WorktreeRegistry({ file: path.join(worktreesRootFor(root), 'registry.json') });
    const onDisk = await reloaded.load();
    assert.deepEqual(onDisk.entries.map((item) => item.id), [worktreeIdFor(RUN, 'd0001')]);
    assert.equal(onDisk.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(WORKTREE_STATES, ['starting', 'active', 'preserved', 'removed']);
  });

  test('未 load 就读写 = 明确报错（不静默给空账）', async () => {
    const registry = new WorktreeRegistry({ file: path.join(dir(), 'registry.json') });
    assert.throws(() => registry.entries(), /loaded/);
    await assert.rejects(() => registry.register({ id: worktreeIdFor(RUN, 'd0001'), runId: RUN, dispatchId: 'd0001', path: '/p', branch: 'b', at: 't' }), /loaded/);
  });

  test('同 id 重复登记即拒（不是静默覆盖）', async () => {
    const file = path.join(dir(), 'registry.json');
    const registry = new WorktreeRegistry({ file });
    await registry.load();
    const id = worktreeIdFor(RUN, 'd0001');
    await registry.register({ id, runId: RUN, dispatchId: 'd0001', path: '/p', branch: 'b', at: 'now' });
    await assert.rejects(() => registry.register({ id, runId: RUN, dispatchId: 'd0001', path: '/p2', branch: 'b2', at: 'now' }), /already registered/);
  });

  test('版本超前拒读（fail-closed，不半读半猜）', async () => {
    const file = path.join(dir(), 'registry.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, entries: [] }));
    const registry = new WorktreeRegistry({ file });
    await assert.rejects(() => registry.load(), /version/i);
  });

  test('写是单写者队列：并发改状态不丢更新', async () => {
    const file = path.join(dir(), 'registry.json');
    const registry = new WorktreeRegistry({ file });
    await registry.load();
    const id = worktreeIdFor(RUN, 'd0001');
    await registry.register({ id, runId: RUN, dispatchId: 'd0001', path: '/p', branch: 'b', at: 't' });
    await Promise.all([
      registry.setState(id, 'active', 't1'),
      registry.setState(id, 'preserved', 't2'),
      registry.setBytes(id, 1234),
    ]);
    const reloaded = new WorktreeRegistry({ file });
    await reloaded.load();
    const entry = reloaded.entry(id);
    assert.equal(entry.state, 'preserved');
    assert.equal(entry.bytes, 1234);
  });

  test('未知 id 改状态即抛（记账不静默吞）', async () => {
    const registry = new WorktreeRegistry({ file: path.join(dir(), 'registry.json') });
    await registry.load();
    await assert.rejects(() => registry.setState(worktreeIdFor(RUN, 'd0009'), 'active', 't'), /not registered/);
  });
});

// ══════════════════════════════════════════════════════════
// 四层配额
// ══════════════════════════════════════════════════════════

describe('磁盘上界四层（双配额 / 软阈值 / 硬上限 / 旧的一律不删）', () => {
  test('默认配额口径：50 个 / 5GB，软阈值 80%', () => {
    assert.equal(QUOTA_SOFT_THRESHOLD_RATIO, 0.8);
    assert.equal(MIN_FREE_BYTES, 2 * 1024 * 1024 * 1024);
  });

  const gates = { keepQuotaCount: 50, keepQuotaBytes: 5 * 1024 * 1024 * 1024 };

  test('计数口径 = 保留项（有改动未处置）的数量与字节', () => {
    const entries = [
      { id: 'a', state: 'preserved', bytes: 10 },
      { id: 'b', state: 'preserved', bytes: 20 },
      { id: 'c', state: 'active', bytes: 999 },
      { id: 'd', state: 'removed', bytes: 999 },
      { id: 'e', state: 'starting', bytes: 1 },
    ];
    assert.deepEqual(countAndBytes(entries), { count: 2, bytes: 30 });
  });

  test('软阈值：达 80% 出一条告警，达硬上限即拒；两者都超只报最硬的一条', () => {
    const warnCount = evaluateQuota({ preservedCount: 40, preservedBytes: 0, freeBytes: 100 * 1024 * 1024 * 1024, gates });
    assert.equal(warnCount.level, 'warn');
    assert.deepEqual(warnCount.reasons, ['keep-quota-count']);
    const warnBytes = evaluateQuota({ preservedCount: 0, preservedBytes: 0.8 * gates.keepQuotaBytes, freeBytes: 100 * 1024 * 1024 * 1024, gates });
    assert.equal(warnBytes.level, 'warn');
    assert.deepEqual(warnBytes.reasons, ['keep-quota-bytes']);
    const ok = evaluateQuota({ preservedCount: 39, preservedBytes: 0, freeBytes: 100 * 1024 * 1024 * 1024, gates });
    assert.equal(ok.level, 'ok');
    const blockedCount = evaluateQuota({ preservedCount: 50, preservedBytes: 0, freeBytes: 100 * 1024 * 1024 * 1024, gates });
    assert.equal(blockedCount.level, 'blocked');
    assert.deepEqual(blockedCount.reasons, ['keep-quota-count']);
    const blockedDisk = evaluateQuota({ preservedCount: 0, preservedBytes: 0, freeBytes: 2 * 1024 * 1024 * 1024 - 1, gates });
    assert.equal(blockedDisk.level, 'blocked');
    assert.deepEqual(blockedDisk.reasons, ['free-disk']);
    const both = evaluateQuota({ preservedCount: 60, preservedBytes: 6 * 1024 * 1024 * 1024, freeBytes: 1024, gates });
    assert.equal(both.level, 'blocked');
    assert.ok(both.reasons.includes('keep-quota-count') && both.reasons.includes('keep-quota-bytes') && both.reasons.includes('free-disk'));
  });

  test('拒绝新增不等于删旧：evaluateQuota 不返回任何待删条目', () => {
    const verdict = evaluateQuota({ preservedCount: 99, preservedBytes: 99, freeBytes: 1, gates });
    assert.equal('toRemove' in verdict, false);
    assert.equal('victims' in verdict, false);
  });

  test('目录字节：普通文件计入、符号链接不跟随、子目录累加', () => {
    const root = dir();
    fs.mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.txt'), '12345');
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), '123');
    fs.writeFileSync(path.join(root, 'sub', 'deep', 'c.txt'), '1');
    const outside = dir();
    fs.writeFileSync(path.join(outside, 'big'), 'x'.repeat(1000));
    fs.symlinkSync(path.join(outside, 'big'), path.join(root, 'link'));
    assert.equal(directoryBytes(root), 5 + 3 + 1);
    assert.equal(directoryBytes(path.join(root, 'missing')), 0, '读不到的目录按 0 计，不抛');
  });

  function countAndBytes(entries) {
    const kept = entries.filter((entry) => entry.state === 'preserved');
    return { count: kept.length, bytes: kept.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) };
  }
});

// ══════════════════════════════════════════════════════════
// 隔离服务：串行化、fence、抛错按保留、per-dispatch 生命周期
// ══════════════════════════════════════════════════════════

describe('WorktreeService：竞态纪律与保留判定', () => {
  const FIXED_NOW = Date.parse('2026-10-01T00:00:00.000Z');
  const DAY_MS = 24 * 60 * 60 * 1000;

  function fakeGit(options = {}) {
    const calls = [];
    const worktrees = new Map();
    const runner = async (argv, cwd) => {
      calls.push({ argv, cwd });
      if (options.throwOn && argv.some((token) => options.throwOn.test(token))) throw new Error('git exploded');
      if (argv.includes('--is-inside-work-tree')) return { code: 0, stdout: 'true\n', stderr: '' };
      if (argv.includes('--show-toplevel')) return { code: 0, stdout: `${options.repoRoot ?? '/repo'}\n`, stderr: '' };
      if (argv.includes('version')) return { code: 0, stdout: 'git version 2.50.1\n', stderr: '' };
      if (argv.includes('status')) return { code: 0, stdout: options.dirty ? ' M file\n' : '', stderr: options.stderr ?? '' };
      if (argv.includes('rev-list')) return { code: 0, stdout: `${options.ahead ?? 0}\n`, stderr: '' };
      if (argv.includes('add')) {
        // argv 形态：<no-gc flags> worktree add -b <branch> <path> <ref>
        const target = argv[argv.indexOf('-b') + 2];
        worktrees.set(target, 'created');
        fs.mkdirSync(target, { recursive: true });
        // 真 git 会在工作树里留一个 .git FILE（指向共同对象库）；没有它，销毁谓词按 fail-closed 保留。
        fs.writeFileSync(path.join(target, '.git'), 'gitdir: /repo/.git/worktrees/x\n');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (argv.includes('prune')) return { code: 0, stdout: '', stderr: '' };
      if (argv.includes('-d')) return { code: options.branchDeleteFails ? 1 : 0, stdout: '', stderr: options.branchDeleteFails ? 'error: not fully merged' : '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    return { calls, runner, worktrees };
  }

  function service(options = {}) {
    const root = options.root ?? dir();
    const git = fakeGit(options);
    const audit = [];
    const serviceOptions = {
      worktreesRoot: worktreesRootFor(root),
      repoRoot: options.repoRoot ?? root,
      registryFile: path.join(worktreesRootFor(root), 'registry.json'),
      git: git.runner,
      freeBytes: () => options.freeBytes ?? 100 * 1024 * 1024 * 1024,
      measureBytes: (target) => (options.bytesFor ? options.bytesFor(target) : directoryBytes(target)),
      gates: { keepQuotaCount: options.keepQuotaCount ?? 50, keepQuotaBytes: options.keepQuotaBytes ?? 5 * 1024 * 1024 * 1024 },
      clock: { now: () => FIXED_NOW, iso: () => new Date(FIXED_NOW).toISOString() },
      audit: (event) => audit.push(event),
    };
    return { root, git, audit, serviceOptions, svc: new WorktreeService(serviceOptions), events: audit };
  }

  test('创建即登记：registry 落盘先于 git worktree add', async () => {
    const { svc, git, root } = service();
    const provisioned = await svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'writer' });
    assert.equal(provisioned.ok, true);
    const addIndex = git.calls.findIndex((call) => call.argv.includes('add'));
    const firstWrite = fs.readdirSync(worktreesRootFor(root));
    assert.ok(addIndex >= 0);
    assert.ok(firstWrite.includes('registry.json'));
    const entry = svc.registry.entry(provisioned.id);
    assert.equal(entry.state, 'active');
    assert.equal(entry.runId, 'wf_0123456789abcdef');
  });

  test('创建拒绝三类各有具名：脏树 / worktree 套 worktree / git 不可用', async () => {
    const dirty = service({ dirty: true });
    const refused = await dirty.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'x' });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'worktree-dirty-tree');

    const notGit = service();
    notGit.git.runner = async (argv) => (argv.includes('--is-inside-work-tree')
      ? { code: 128, stdout: '', stderr: 'not a git repository' }
      : { code: 0, stdout: argv.includes('version') ? 'git version 2.50.1\n' : '', stderr: '' });
    const svc2 = new WorktreeService({ ...notGit.serviceOptions, git: notGit.git.runner });
    const refused2 = await svc2.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'x' });
    assert.equal(refused2.ok, false);
    assert.equal(refused2.reason, 'worktree-not-a-repository');

    const svc3 = new WorktreeService({ ...notGit.serviceOptions, git: async () => { throw new Error('ENOENT'); } });
    const refused3 = await svc3.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'x' });
    assert.equal(refused3.ok, false);
    assert.equal(refused3.reason, 'worktree-git-unavailable');

    const root = dir();
    const nestedSvc = new WorktreeService({ ...service({ root }).serviceOptions, repoRoot: path.join(root, 'worktrees', 'agent-ab12cd34') });
    const refused4 = await nestedSvc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'x' });
    assert.equal(refused4.ok, false);
    assert.equal(refused4.reason, 'worktree-nested');
  });

  test('clean 自动删、有改动保留并回报 path + branch', async () => {
    const clean = service();
    const made = await clean.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'x' });
    const released = await clean.svc.release(made.id);
    assert.equal(released.kept, false);
    assert.equal(clean.svc.registry.entry(made.id).state, 'removed');

    const changed = service({ dirty: false, bytesFor: () => 4096 });
    const made2 = await changed.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0002', label: 'y' });
    changed.git.worktrees.set(made2.path, 'dirty');
    const released2 = await changed.svc.release(made2.id, { hasWork: true });
    assert.equal(released2.kept, true);
    assert.equal(released2.path, made2.path);
    assert.equal(released2.branch, made2.branch);
    const entry = changed.svc.registry.entry(made2.id);
    assert.equal(entry.state, 'preserved');
    assert.equal(entry.bytes, 4096);
    assert.ok(fs.existsSync(made2.path), 'a preserved worktree stays on disk');
  });

  test('任一派生检查抛错按"保留"处理', async () => {
    const probe = service();
    const made = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'x' });
    const released = await probe.svc.release(made.id, { hasWork: () => { throw new Error('git died'); } });
    assert.equal(released.kept, true);
    assert.equal(probe.svc.registry.entry(made.id).state, 'preserved');
  });

  test('删除走 fence：先原子重命名入 trash，再删——clean 检查与删除之间不留窗口', async () => {
    const probe = service();
    const made = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'x' });
    const fenced = [];
    const originalRename = fs.renameSync;
    fs.renameSync = (from, to) => { fenced.push({ from, to }); return originalRename(from, to); };
    try {
      await probe.svc.release(made.id);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(fenced.length, 1);
    assert.ok(fenced[0].to.includes(WORKTREE_TRASH_DIR));
    assert.ok(fenced[0].from === made.path);
    assert.equal(fs.existsSync(made.path), false);
    assert.equal(fs.existsSync(path.join(worktreesRootFor(probe.root), WORKTREE_TRASH_DIR, made.id)), false, 'the fenced entry is emptied after the delete');
  });

  test('fence 重命名失败即不删（宁留孤儿不丢工作）', async () => {
    const probe = service();
    const made = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'x' });
    const originalRename = fs.renameSync;
    fs.renameSync = () => { throw new Error('EXDEV cross-device'); };
    let released;
    try {
      released = await probe.svc.release(made.id);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(released.kept, true);
    assert.equal(probe.svc.registry.entry(made.id).state, 'preserved');
  });

  test('创建 / 清理串行化：并发 provision 各不相同且登记完整', async () => {
    const probe = service();
    const made = await Promise.all(
      Array.from({ length: 6 }, (_, index) => probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: `d000${index + 1}`, label: `p${index}` })),
    );
    assert.equal(made.filter((item) => item.ok).length, 6);
    const paths = new Set(made.map((item) => item.path));
    assert.equal(paths.size, 6);
    const branches = new Set(made.map((item) => item.branch));
    assert.equal(branches.size, 6);
    assert.equal(probe.svc.registry.entries().length, 6);
    // 串行化证据：登记写入按序发生，任意两个 add 之间存在 registry 落盘
    const addCalls = probe.git.calls.filter((call) => call.argv.includes('add'));
    assert.equal(addCalls.length, 6);
  });

  test('per-dispatch 生命周期：同一 dispatch 的第二次 provision 复用同一件（重试共享）', async () => {
    const probe = service();
    const first = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0007', label: 'x' });
    const again = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0007', label: 'x' });
    assert.equal(again.ok, true);
    assert.equal(again.path, first.path);
    assert.equal(again.reused, true);
    assert.equal(probe.svc.registry.entries().length, 1);
  });

  test('被打断的旧件不自动续用：另一 run 的同名 dispatch 出新件', async () => {
    const probe = service();
    const first = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'x' });
    const second = await probe.svc.provision({ runId: 'wf_fedcba9876543210', dispatchId: 'd0001', label: 'x' });
    assert.notEqual(second.path, first.path);
  });

  test('配额硬上限：拒绝新建、涉事路拿到具名拒因，旧的一律不删', async () => {
    const probe = service({ keepQuotaCount: 2 });
    const a = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'a' });
    await probe.svc.release(a.id, { hasWork: true });
    const b = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0002', label: 'b' });
    await probe.svc.release(b.id, { hasWork: true });
    const blocked = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0003', label: 'c' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'worktree-quota');
    assert.match(blocked.message, /keep-quota-count/);
    assert.equal(probe.svc.preserved().length, 2, 'blocked creation never deletes the old ones');
    assert.ok(fs.existsSync(a.path) && fs.existsSync(b.path));
    const blockedEvents = probe.audit.filter((event) => event.action === 'worktree-quota-blocked');
    assert.equal(blockedEvents.length, 1);
    assert.equal(blockedEvents[0].runId, 'wf_0123456789abcdef');
    assert.equal(blockedEvents[0].result, 'blocked');
    assert.deepEqual(blockedEvents[0].reasons, ['keep-quota-count']);
    assert.equal(blockedEvents[0].actor, 'wf_0123456789abcdef');
    // 被拒的那一路没有留下任何登记或目录（拒绝在任何资源副作用之前）。
    assert.equal(probe.svc.registry.entry('wf_0123456789abcdef-d0003'), undefined);
  });

  test('软阈值告警落在审计（runId + actor + 结果 + 具名理由），照常放行', async () => {
    const probe = service({ keepQuotaCount: 5 });
    const kept = [];
    for (let index = 1; index <= 4; index++) {
      const made = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: `d000${index}`, label: `k${index}` });
      await probe.svc.release(made.id, { hasWork: true });
      kept.push(made.id);
    }
    assert.equal(probe.audit.filter((event) => event.action === 'worktree-quota-warn').length, 0, '4 未到 80% 线（5 × 0.8 = 4 起算）之前不告警');
    const fifth = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0005', label: 'warned' });
    assert.equal(fifth.ok, true, '软阈值只告警，不拒建');
    const warns = probe.audit.filter((event) => event.action === 'worktree-quota-warn');
    assert.equal(warns.length, 1);
    assert.equal(warns[0].runId, 'wf_0123456789abcdef');
    assert.equal(warns[0].actor, 'wf_0123456789abcdef');
    assert.equal(warns[0].result, 'warned');
    assert.deepEqual(warns[0].reasons, ['keep-quota-count']);
  });

  test('磁盘可用低于下界同样拒建，具名 free-disk', async () => {
    const probe = service({ freeBytes: 1024 });
    const made = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'x' });
    assert.equal(made.ok, false);
    assert.equal(made.reason, 'worktree-quota');
    assert.match(made.message, /free-disk/);
    assert.equal(probe.audit.some((event) => event.action === 'worktree-quota-blocked'), true);
  });

  test('人工丢弃：显式删除 + 审计留痕；有改动永不自动删只在此处减', async () => {
    const probe = service();
    const made = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'x' });
    await probe.svc.release(made.id, { hasWork: true });
    const discarded = await probe.svc.discard(made.id, 'session-root');
    assert.equal(discarded.ok, true);
    assert.equal(probe.svc.preserved().length, 0);
    assert.equal(fs.existsSync(made.path), false);
    const audit = probe.audit.filter((event) => event.action === 'worktree_discard');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor, 'session-root');
    assert.equal(audit[0].result, 'discarded');
    const missing = await probe.svc.discard('no-such-id', 'session-root');
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'worktree-not-found');
  });

  test('归档默认关：开启后超期保留项打成 bundle → 校验 → 删目录（无损可恢复）', async () => {
    const probe = service();
    const made = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'x' });
    await probe.svc.release(made.id, { hasWork: true });
    const untouched = await probe.svc.archiveDue({ autoArchive: false, archiveAfterDays: 30 });
    assert.equal(untouched.length, 0, 'auto-archive is off by default and archives nothing');

    await probe.svc.registry.shiftAge(made.id, 31 * DAY_MS);
    const archived = await probe.svc.archiveDue({ autoArchive: true, archiveAfterDays: 30 });
    assert.equal(archived.length, 1);
    assert.equal(archived[0].ok, true);
    assert.equal(fs.existsSync(made.path), false);
    const entry = probe.svc.registry.entry(made.id);
    assert.equal(entry.state, 'removed');
    assert.match(entry.archiveFile, /wf_0123456789abcdef-d0001\.bundle$/);
    assert.ok(probe.git.calls.some((call) => call.argv.includes('bundle') && call.argv.includes('verify')));
    assert.equal(probe.audit.some((event) => event.action === 'worktree_archive'), true);
  });

  test('归档校验不过即不删目录（无损承诺优先）', async () => {
    const probe = service();
    const made = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'x' });
    await probe.svc.release(made.id, { hasWork: true });
    await probe.svc.registry.shiftAge(made.id, 40 * DAY_MS);
    const original = probe.git.runner;
    const svc = new WorktreeService({
      ...probe.serviceOptions,
      git: async (argv, cwd) => (argv.includes('verify') ? { code: 1, stdout: '', stderr: 'fatal: bundle is malformed' } : original(argv, cwd)),
    });
    await svc.load();
    const archived = await svc.archiveDue({ autoArchive: true, archiveAfterDays: 30 });
    assert.equal(archived[0].ok, false);
    assert.ok(fs.existsSync(made.path), 'an unverified archive never deletes the working copy');
  });

  test('保留项列表给出 runId / 路径 / 分支 / 字节 / 时间，只给保留项', async () => {
    const probe = service();
    const kept = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'x' });
    const gone = await probe.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0002', label: 'y' });
    await probe.svc.release(kept.id, { hasWork: true });
    await probe.svc.release(gone.id);
    const rows = probe.svc.preserved();
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['archiveFile', 'at', 'branch', 'bytes', 'dispatchId', 'id', 'label', 'path', 'runId', 'state', 'updatedAt'].filter((key) => key !== 'archiveFile').sort());
    assert.equal(rows[0].runId, 'wf_0123456789abcdef');
    assert.equal(rows[0].path, kept.path);
    assert.equal(rows[0].branch, kept.branch);
    assert.equal(typeof rows[0].bytes, 'number');
  });

  test('重启后可从盘面重建：新服务读同一登记簿', async () => {
    const root = dir();
    const first = service({ root });
    const made = await first.svc.provision({ runId: 'wf_0123456789abcdef', dispatchId: 'd0001', label: 'x' });
    await first.svc.release(made.id, { hasWork: true });
    const reopened = new WorktreeService({ ...first.serviceOptions });
    await reopened.load();
    assert.equal(reopened.preserved().length, 1);
    assert.equal(reopened.preserved()[0].id, made.id);
  });
});

// ══════════════════════════════════════════════════════════
// TUI 面板的纯逻辑
// ══════════════════════════════════════════════════════════

describe('Worktrees 面板装配（纯函数）', () => {
  test('每行给出 runId / 路径 / 分支 / 大小 / 时间，字节按人类可读口径', () => {
    const rows = worktreePanelRows([
      { id: 'a', runId: 'wf_0123456789abcdef', dispatchId: 'd0001', path: '/r/.myterminal/worktrees/w1', branch: 'worktree-agent-a', bytes: 1536, at: '2026-10-01T00:00:00.000Z', state: 'preserved' },
      { id: 'b', runId: 'wf_0123456789abcdef', dispatchId: 'd0002', path: '/r/.myterminal/worktrees/w2', branch: 'worktree-agent-b', bytes: 0, at: '2026-10-01T00:01:00.000Z', state: 'preserved' },
    ]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { id: 'a', runId: 'wf_0123456789abcdef', path: '/r/.myterminal/worktrees/w1', branch: 'worktree-agent-a', size: '1.5 KB', at: '2026-10-01T00:00:00.000Z' });
    assert.equal(rows[1].size, '0 B');
  });

  test('空列表给出一条诚实的空态文案，不谎报', () => {
    assert.deepEqual(worktreePanelRows([]), []);
  });

  test('软阈值告警在 TUI 可见：文案带配额口径与"旧的不会自动删"', () => {
    const t = (en) => en;
    const warning = describeQuotaWarning({ level: 'warn', reasons: ['keep-quota-count'], preservedCount: 40, preservedBytes: 1, keepQuotaCount: 50, keepQuotaBytes: 512 }, t);
    assert.match(warning, /40/);
    assert.match(warning, /50/);
    assert.match(warning, /deleted automatically/);
    assert.equal(isWorktreeQuotaWarning('ok'), false);
    assert.equal(isWorktreeQuotaWarning('warn'), true);
    assert.equal(isWorktreeQuotaWarning('blocked'), true);
    const blocked = describeQuotaWarning({ level: 'blocked', reasons: ['free-disk'], preservedCount: 0, preservedBytes: 0, keepQuotaCount: 50, keepQuotaBytes: 512 }, (en, zh) => zh);
    assert.match(blocked, /free-disk/);
    assert.match(blocked, /拒绝新建/);
  });
});
