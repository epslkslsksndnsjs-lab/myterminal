// ADR-0051 W3-02 (#94)：myterminal l3-model fetch 子命令（0050 I-27 后半 + 0051 D-7）
//
// 验收断言：
//   AC1  子命令存在（CLI 帮助可见 l3-model fetch；未知 l3-model 子命令报错退出 1）
//   AC2  sha256 校验值钉死 aaf42c8b…9223（常量导出 + 64 位 hex 断言；校验失败 → 报错且不落盘）
//   AC3  可重试（网络中断首跑失败无残留，重跑成功）
//   AC4  幂等（重跑已完成下载 → 校验通过输出「已就绪」当 status，不重新下载）
//   AC5  完成输出四要素（进度 → sha256 ✓ → 落盘路径 → 「L3 模型已就绪，下次启动自动预热」）
//   AC6  落盘位置与 W3-01 解析链一致（modelFilePath() 与 installationRoot+models+DEFAULT 同源，
//        禁两处漂移；dev 与 release 推导分别断言）
//   AC7  首次启动提示「运行 myterminal l3-model fetch 启用 L3」（模型缺失时；模型存在静默不泄漏 D-8）
//   AC8  端到端闭环：fetch 落盘 → 重启预热命中（l3ModelPath 解析链命中安装根 models）
//
// 测试方式：单测直接驱动 ../dist/l3/model-fetch.js + ../dist/l3/registry.js + ../dist/l3/warmup.js
// （build 产物，遵循 issue-31 seam）；下载逻辑经 fetcher 注入假 HTTP（断点/重试/校验失败/幂等，
// 与 update.ts checkForUpdate 同模式）；sha256 校验器用已知向量单独验证；CLI 经 spawnSync node
// （遵循 cli-regression.test.mjs 手法）；安装根经 MYTERMINAL_HOME 指向 mkdtemp 临时目录
// （禁绝对路径字面量，遵循 issue-W301-modelpath.test.mjs 手法）。
// 注：任何 src 改动后必须先 bun run build 再跑测试（测试全部从 dist 导入，历史教训见 #43）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  fetchL3Model, L3_MODEL_SHA256, L3_MODEL_SOURCE_URL,
  runL3ModelFetchCli, formatFetchCompletion, sha256File,
} from '../dist/l3/model-fetch.js';
import { DEFAULT_L3_MODEL_PATH, l3ModelPath, modelFilePath, resetL3Adapter, resetL3AdapterInstance, registerAdapterFactory } from '../dist/l3/registry.js';
import { installationRoot } from '../dist/update.js';
import { resetL3Warmup, startL3Warmup, WARMUP_MAX_RETRIES } from '../dist/l3/warmup.js';

const CLI = path.resolve('dist/cli.js');

/** 已知向量（NIST FIPS 180-2 标准样例）：sha256("hello") 的钉死摘要。 */
const SHA256_HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

/** 下载 fixture：固定字节（校验值在测试内按 reference 实现计算；真实钉死值对应 1.2GB 真模型）。 */
const FIXTURE = new TextEncoder().encode('l3-model-fixture-bytes-for-w302-fetch-test');
const FIXTURE_SHA256 = createHash('sha256').update(FIXTURE).digest('hex');

/** 假 HTTP fetcher（与 update.ts checkForUpdate 注入同模式）。mode: 'ok' | 'drop' | 'throw'。 */
function makeFetcher({ body = FIXTURE, mode = 'ok', dropAfter = 16 } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (mode === 'throw') throw new Error('network down');
    if (mode === 'drop') {
      let pulled = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (pulled === 0) {
            controller.enqueue(body.slice(0, dropAfter));
            pulled += 1;
          } else {
            controller.error(new Error('connection reset'));
          }
        },
      });
      return new Response(stream, { status: 200 });
    }
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
  };
  return { fetcher, calls };
}

// ── env 保存/还原工具（value=undefined → 删除该变量；与 issue-W301 同模式）──────

function withEnv(patch, fn) {
  const saved = new Map();
  for (const key of Object.keys(patch)) saved.set(key, process.env[key]);
  let restored = false;
  const restoreOnce = () => {
    if (restored) return;
    restored = true;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const result = fn();
    // async 回调：env 需在 Promise settle 后才还原（异步体全程保持注入环境）
    if (result && typeof result.then === 'function') return result.finally(restoreOnce);
    restoreOnce();
    return result;
  } catch (error) {
    restoreOnce();
    throw error;
  }
}

/** 临时安装根（初始为空 models 目录；mkdtemp 禁绝对路径字面量）。 */
function makeInstallRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'models'), { recursive: true });
  return root;
}

function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

afterEach(() => resetL3AdapterInstance()); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入）

// ── AC2：sha256 校验器 + 钉死值 ───────────────────────────────────────────────

test('AC2 sha256File 校验器命中已知向量（streaming 与 reference 一致）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w302-sha-'));
  try {
    const file = path.join(dir, 'hello.txt');
    fs.writeFileSync(file, 'hello');
    assert.strictEqual(await sha256File(file), SHA256_HELLO);
  } finally {
    rmTmp(dir);
  }
});

test('AC2 sha256 钉死值 = 票文 aaf42c8b…9223（64 位 hex）', () => {
  assert.match(L3_MODEL_SHA256, /^[0-9a-f]{64}$/);
  assert.strictEqual(L3_MODEL_SHA256, 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223');
  assert.match(L3_MODEL_SOURCE_URL, /^https:\/\/huggingface\.co\/unsloth\/Qwen3\.5-2B-GGUF\/resolve\/main\//);
});

// ── AC2/AC3/AC4：下载逻辑（注入假 HTTP）────────────────────────────────────────

test('AC2 下载成功：落盘目标 + 进度回调收到字节 + .part 无残留', async () => {
  const root = makeInstallRoot('w302-ok-');
  const target = path.join(root, 'models', DEFAULT_L3_MODEL_PATH);
  const { fetcher, calls } = makeFetcher();
  const progress = [];
  try {
    const result = await fetchL3Model({
      fetcher, targetPath: target, expectedSha256: FIXTURE_SHA256,
      onProgress: (received, total) => progress.push({ received, total }),
    });
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.path, target);
    assert.strictEqual(result.bytesDownloaded, FIXTURE.length);
    assert.strictEqual(fs.readFileSync(target).toString(), new TextDecoder().decode(FIXTURE));
    assert.ok(!fs.existsSync(`${target}.part`), '.part 不应残留');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, L3_MODEL_SOURCE_URL);
    assert.ok(progress.length >= 1, '进度回调应触发');
    assert.strictEqual(progress[progress.length - 1].received, FIXTURE.length);
    assert.strictEqual(progress[progress.length - 1].total, FIXTURE.length);
  } finally {
    rmTmp(root);
  }
});

test('AC2 校验失败 → 报错且不落盘（.part 清理）', async () => {
  const root = makeInstallRoot('w302-bad-');
  const target = path.join(root, 'models', DEFAULT_L3_MODEL_PATH);
  const { fetcher } = makeFetcher();
  try {
    const result = await fetchL3Model({ fetcher, targetPath: target, expectedSha256: '0'.repeat(64) });
    assert.strictEqual(result.status, 'error');
    assert.match(result.error, /sha256/i);
    assert.ok(!fs.existsSync(target), '校验失败不得落盘');
    assert.ok(!fs.existsSync(`${target}.part`), '.part 应清理');
  } finally {
    rmTmp(root);
  }
});

test('AC2 默认钉死值接线：不注入 expectedSha256 → 非钉死内容校验失败', async () => {
  const root = makeInstallRoot('w302-pin-');
  const target = path.join(root, 'models', DEFAULT_L3_MODEL_PATH);
  const { fetcher } = makeFetcher();
  try {
    const result = await fetchL3Model({ fetcher, targetPath: target });
    assert.strictEqual(result.status, 'error'); // fixture 不可能命中真实钉死值
    assert.match(result.error, /sha256/i);
    assert.ok(!fs.existsSync(target));
  } finally {
    rmTmp(root);
  }
});

test('AC3 断点（流中途网络中断）→ error、无落盘、无 .part 残留；重跑成功', async () => {
  const root = makeInstallRoot('w302-drop-');
  const target = path.join(root, 'models', DEFAULT_L3_MODEL_PATH);
  try {
    const dropped = makeFetcher({ mode: 'drop' });
    const first = await fetchL3Model({ fetcher: dropped.fetcher, targetPath: target, expectedSha256: FIXTURE_SHA256 });
    assert.strictEqual(first.status, 'error');
    assert.match(first.error, /connection reset|reset/i);
    assert.ok(!fs.existsSync(target));
    assert.ok(!fs.existsSync(`${target}.part`), '断点后 .part 必须清理（可重试前提）');

    const retry = makeFetcher({ mode: 'ok' });
    const second = await fetchL3Model({ fetcher: retry.fetcher, targetPath: target, expectedSha256: FIXTURE_SHA256 });
    assert.strictEqual(second.status, 'ok');
    assert.strictEqual(fs.readFileSync(target).toString(), new TextDecoder().decode(FIXTURE));
  } finally {
    rmTmp(root);
  }
});

test('AC4 幂等：目标已存在且 sha256 命中 → ready「已就绪」不下载（fetcher 零调用）', async () => {
  const root = makeInstallRoot('w302-ready-');
  const target = path.join(root, 'models', DEFAULT_L3_MODEL_PATH);
  fs.writeFileSync(target, FIXTURE);
  const { fetcher, calls } = makeFetcher();
  try {
    const result = await fetchL3Model({ fetcher, targetPath: target, expectedSha256: FIXTURE_SHA256 });
    assert.strictEqual(result.status, 'ready');
    assert.strictEqual(result.bytesDownloaded, 0);
    assert.strictEqual(calls.length, 0, '已就绪不得发起下载');
    assert.strictEqual(fs.readFileSync(target).toString(), new TextDecoder().decode(FIXTURE));
  } finally {
    rmTmp(root);
  }
});

test('AC4 幂等负例：目标存在但哈希不符（损坏/残缺）→ 重新下载覆盖', async () => {
  const root = makeInstallRoot('w302-repair-');
  const target = path.join(root, 'models', DEFAULT_L3_MODEL_PATH);
  fs.writeFileSync(target, 'corrupted-stale-bytes');
  const { fetcher } = makeFetcher();
  try {
    const result = await fetchL3Model({ fetcher, targetPath: target, expectedSha256: FIXTURE_SHA256 });
    assert.strictEqual(result.status, 'ok'); // 损坏文件被重新下载替换
    assert.strictEqual(fs.readFileSync(target).toString(), new TextDecoder().decode(FIXTURE));
  } finally {
    rmTmp(root);
  }
});

// ── AC5：完成输出四要素（进度 → sha256 ✓ → 落盘路径 → 已就绪预热行）────────────

test('AC5 完成输出四要素（formatFetchCompletion + CLI 处理器 stdout）', async () => {
  const root = makeInstallRoot('w302-cli-');
  try {
    const { fetcher } = makeFetcher();
    const lines = [];
    const code = await runL3ModelFetchCli({
      fetcher,
      targetPath: path.join(root, 'models', DEFAULT_L3_MODEL_PATH),
      expectedSha256: FIXTURE_SHA256,
      out: (line) => lines.push(line),
    });
    assert.strictEqual(code, 0);
    assert.ok(lines.some((l) => l.startsWith('\r下载中')), '要素1 进度缺失');
    assert.ok(lines.some((l) => /sha256 ✓/.test(l)), '要素2 sha256 ✓ 缺失');
    assert.ok(lines.some((l) => l.includes('落盘路径')), '要素3 落盘路径缺失');
    assert.ok(lines.some((l) => l.includes('L3 模型已就绪，下次启动自动预热')), '要素4 预热行缺失');

    const okLines = formatFetchCompletion({ status: 'ok', path: '/p', bytesDownloaded: 1 });
    assert.ok(okLines.some((l) => /sha256 ✓/.test(l) && l.includes(L3_MODEL_SHA256)));
    assert.ok(okLines.some((l) => l.includes('落盘路径 /p')));
    assert.ok(okLines.some((l) => l.includes('L3 模型已就绪，下次启动自动预热')));
    const readyLines = formatFetchCompletion({ status: 'ready', path: '/p', bytesDownloaded: 0 });
    assert.ok(readyLines.some((l) => l.includes('已就绪')), '幂等重跑应输出「已就绪」当 status');
  } finally {
    rmTmp(root);
  }
});

test('AC5 错误路径：CLI 处理器返回 1 并输出失败原因', async () => {
  const root = makeInstallRoot('w302-cli-err-');
  try {
    const { fetcher } = makeFetcher({ mode: 'throw' });
    const lines = [];
    const code = await runL3ModelFetchCli({
      fetcher,
      targetPath: path.join(root, 'models', DEFAULT_L3_MODEL_PATH),
      expectedSha256: FIXTURE_SHA256,
      out: (line) => lines.push(line),
    });
    assert.strictEqual(code, 1);
    assert.ok(lines.some((l) => l.includes('l3-model fetch 失败')));
  } finally {
    rmTmp(root);
  }
});

// ── AC1：CLI 子命令注册（spawn node，遵循 cli-regression 手法）─────────────────

test('AC1 CLI 帮助可见 l3-model fetch', () => {
  const help = spawnSync('node', [CLI, '--help'], { encoding: 'utf8', timeout: 15_000 });
  assert.strictEqual(help.status, 0, help.stderr);
  assert.match(help.stdout, /l3-model fetch/);
});

test('AC1 l3-model 未知子命令 → 报错退出 1（argv 派发已注册）', () => {
  const root = makeInstallRoot('w302-bogus-');
  try {
    const run = spawnSync('node', [CLI, 'l3-model', 'bogus'], {
      encoding: 'utf8', timeout: 15_000, env: { ...process.env, MYTERMINAL_HOME: root },
    });
    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /未知 l3-model 子命令/);
  } finally {
    rmTmp(root);
  }
});

// ── AC6：落盘位置与 W3-01 解析链严格同源（禁两处漂移）──────────────────────────

test('AC6 modelFilePath() === installationRoot()/models/DEFAULT（同源拼接，env 场景）', () => {
  const root = makeInstallRoot('w302-src-env-');
  try {
    withEnv({ MYTERMINAL_HOME: root, MYTERMINAL_L3_MODEL_PATH: undefined }, () => {
      // 落盘目标与解析链同源：'models' 与文件名仅 registry 一处字面量（禁两处漂移）
      assert.strictEqual(modelFilePath(), path.join(installationRoot(), 'models', DEFAULT_L3_MODEL_PATH));
    });
  } finally {
    rmTmp(root);
  }
});

test('AC6 dev 推导：无 MYTERMINAL_HOME → 安装根 = dist 模块目录上级', () => {
  withEnv({ MYTERMINAL_HOME: undefined, MYTERMINAL_L3_MODEL_PATH: undefined }, () => {
    // dev 推导：dist/update.js 模块目录上级（installationRoot 以自身 import.meta.url 推导）；
    // 经 dist/update.js 自身 URL 推导期望，不写死绝对路径
    const expectedRoot = path.resolve(path.dirname(path.dirname(new URL('../dist/update.js', import.meta.url).pathname)));
    assert.strictEqual(installationRoot(), expectedRoot);
    assert.strictEqual(modelFilePath(), path.join(expectedRoot, 'models', DEFAULT_L3_MODEL_PATH));
  });
});

test('AC6 release 推导：execPath 形如 <根>/releases/<版本>/myterminal → 安装根取 releases 上级', () => {
  const root = makeInstallRoot('w302-src-rel-');
  const original = process.execPath;
  try {
    Object.defineProperty(process, 'execPath', { value: path.join(root, 'releases', 'v1.2.3', 'myterminal'), configurable: true });
    withEnv({ MYTERMINAL_HOME: undefined, MYTERMINAL_L3_MODEL_PATH: undefined }, () => {
      assert.strictEqual(installationRoot(), root);
      assert.strictEqual(modelFilePath(), path.join(root, 'models', DEFAULT_L3_MODEL_PATH));
    });
  } finally {
    Object.defineProperty(process, 'execPath', { value: original, configurable: true });
    rmTmp(root);
  }
});

// ── AC8：端到端闭环（fetch 落盘 → 重启预热命中）────────────────────────────────

test('AC8 闭环：fetch 落盘安装根 models → 解析链 l3ModelPath 命中（重启预热命中）', async () => {
  const root = makeInstallRoot('w302-e2e-');
  try {
    await withEnv({ MYTERMINAL_HOME: root, MYTERMINAL_L3_MODEL_PATH: undefined }, async () => {
      const { fetcher } = makeFetcher();
      const result = await fetchL3Model({ fetcher, expectedSha256: FIXTURE_SHA256 });
      assert.strictEqual(result.status, 'ok');
      assert.strictEqual(result.path, modelFilePath());
      assert.ok(fs.existsSync(result.path));
      // 「重启」= 新解析（清 env 覆盖后）→ 解析链命中安装根 models（预热 isReady 将加载此路径）
      assert.strictEqual(l3ModelPath(), result.path);
    });
  } finally {
    rmTmp(root);
  }
});

// ── AC7：首次启动提示 —— 整合时让位 #95（D-8 唯一提示处在 missing 早退路径，W303 覆盖；
//     #94 失败分支提示为死路径已删，见整合建议⑤）──────────
