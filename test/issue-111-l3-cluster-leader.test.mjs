// ADR-0051 增补-12（#111 用户实测）：固定端口 leader 默认开 L3 + 预热不绑端口分支
//
// 验收断言：
//   AC1  固定端口单实例启动（tryBecomeLeader 成功）→ l3Enabled()===true + startL3Warmup
//        被调用（l3Health 状态机写入 = 预热已触发） + /health l3 就绪（D8 通道2 等价面）
//   AC2  固定端口第二实例（参与者）→ L3 默认关、无预热（D18.2 保持）
//   AC3  参与者 MYTERMINAL_L3_ENABLED=1 → L3 开 + 预热触发（env 优先）
//   AC4  port 0 standalone 行为零变化（回归锁定：L3 默认开 + 预热）
//   AC5  选举迁移：leader 退出 → 新 leader（参与者接管）L3 翻转开 + 惰性补触发预热
//
// 测试方式：e2e 启动真实 MyTerminalRuntime（dist 产物）。同进程双实例模拟多进程集群：
// memberId 含 randomBytes 不冲突；共享 settingsPath 目录 → 同一 cluster registry 文件
// （clusterKey(host,port)）。真实跨进程时预热门闩进程内独立——同进程模拟需 resetL3Warmup
// 代偿（close 天然重置；participant 起前手动重置模拟新进程门闩）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  l3Enabled,
  setL3ClusterMode,
  resetL3ClusterMode,
  registerAdapterFactory,
  resetL3Adapter, resetL3AdapterInstance,
} from '../dist/l3/registry.js';
import { l3Health, resetL3Health, resetL3Warmup, startL3Warmup } from '../dist/l3/warmup.js';
import { MyTerminalRuntime } from '../dist/server.js';

// 预热必须开（本文件断言预热触发）；防御 bun 共享 worker 泄漏其他文件的
// MYTERMINAL_L3_WARMUP=false / MYTERMINAL_L3_ENABLED=*（#101 同源防御）。
delete process.env.MYTERMINAL_L3_WARMUP;
const SAVED_L3_ENABLED = process.env.MYTERMINAL_L3_ENABLED;
delete process.env.MYTERMINAL_L3_ENABLED;

const CONNECTOR_KEY = 'test-connector-key-1111111111';
const ACTIONS_TOKEN = 'test-actions-token-11111111111111111111';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待条件（warmup 异步 / election 周期 1.8s）。 */
async function pollUntil(cond, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) throw new Error(`pollUntil 超时: ${label}`);
    await sleep(50);
  }
}

/** 计数 fake adapter：isReady/complete 立即成功 → 预热直达 ready（AC 断言依赖）。 */
function injectFake() {
  resetL3Adapter(); // 清旧单例，让本次 factory 在下次懒加载生效（单例常驻语义）
  const adapter = {
    id: 'w111-fake', supportsStructuredOutput: true,
    isReady: async () => true,
    complete: async () => ({ object: { ok: true }, finishReason: 'stop', latencyMs: 1, modelId: 'w111-fake' }),
  };
  registerAdapterFactory(() => adapter);
  return adapter;
}

function tempWorkspace(tag) {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), `myterminal-${tag}-`));
  const stateDir = path.join(workspaceDir, '.myterminal');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'hello myterminal\n');
  return { workspaceDir, stateDir };
}

async function createRuntime(overrides = {}, { keepDirs = false } = {}) {
  const dirs = tempWorkspace('w111');
  const runtime = new MyTerminalRuntime({ ...dirs, settingsPath: path.join(dirs.stateDir, 'test-settings.json'), host: '127.0.0.1', port: 0, connectorKey: CONNECTOR_KEY, actionsToken: ACTIONS_TOKEN, publicBaseUrl: 'http://127.0.0.1:0', maxOutputChars: 20_000, commandTimeoutSec: 10, uiLanguage: 'zh-CN', uiTheme: 'dark', passiveLockEnabled: false, actionsContinuationMode: 'next-call', ...overrides });
  await runtime.start();
  return {
    runtime, dirs, baseUrl: `http://127.0.0.1:${runtime.port}`,
    async close() {
      await runtime.close();
      // keepDirs：participant 的 cluster registry 目录可能指向前者 stateDir
      // （settingsPath 共享）——目录删除延后到测试尾部统一清理（真实场景独立进程不互删）。
      if (!keepDirs) fs.rmSync(dirs.workspaceDir, { recursive: true, force: true });
    },
  };
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

afterEach(() => {
  resetL3ClusterMode();
  resetL3AdapterInstance(); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入）
  resetL3Health();
  resetL3Warmup();
  if (SAVED_L3_ENABLED === undefined) delete process.env.MYTERMINAL_L3_ENABLED;
  else process.env.MYTERMINAL_L3_ENABLED = SAVED_L3_ENABLED;
});

// ── AC1：固定端口单实例 leader ──────────────────────────────────────────────

test('AC1: 固定端口单实例 leader → L3 默认开 + startL3Warmup 触发 + l3 就绪（D8 通道2）', async () => {
  injectFake();
  const port = await findFreePort();
  const server = await createRuntime({ port });
  try {
    assert.strictEqual(l3Enabled({}), true, 'leader 默认开 L3（setL3ClusterMode(!listening) 语义）');
    // l3Health 状态机只有 startL3Warmup 写：loading→ready 即预热已被 start 触发（fake 直达）
    await pollUntil(() => server.runtime.l3Health()?.status === 'ready', '预热就绪');
    assert.equal(server.runtime.l3Health()?.modelId, 'w111-fake', 'ready 回填 fake modelId');
  } finally { await server.close(); }
});

// ── AC2：固定端口第二实例（参与者）──────────────────────────────────────────

test('AC2: 固定端口第二实例（参与者）→ L3 默认关、无预热（D18.2 保持）', async () => {
  injectFake();
  const port = await findFreePort();
  const leader = await createRuntime({ port });
  try {
    assert.strictEqual(l3Enabled({}), true, 'leader 默认开');
    const participant = await createRuntime({
      port,
      // 同 configDir（settingsPath 目录）→ 同一 cluster registry → 参与者可见 leader
      settingsPath: path.join(leader.dirs.stateDir, 'test-settings.json'),
    });
    try {
      assert.strictEqual(l3Enabled({}), false, '参与者 L3 默认关（D18.2）');
      // 无预热：清 leader 遗留状态后，参与者启动不写任何 health（startL3Warmup 内部 gate no-op）
      resetL3Health();
      assert.strictEqual(participant.runtime.l3Health(), undefined, '参与者不写 L3 状态（无预热）');
      // 等一个 election 周期：即使无 leader 冲突也不该被误触发
      await sleep(200);
      assert.strictEqual(participant.runtime.l3Health(), undefined, '仍无预热（参与者 gate 稳定）');
    } finally { await participant.close(); }
  } finally { await leader.close(); }
});

// ── AC3：参与者 env 强制开 ──────────────────────────────────────────────────

test('AC3: 参与者 MYTERMINAL_L3_ENABLED=1 → L3 开 + 预热触发（env 优先）', async () => {
  injectFake();
  const port = await findFreePort();
  const leader = await createRuntime({ port });
  try {
    const participant = await createRuntime({
      port,
      settingsPath: path.join(leader.dirs.stateDir, 'test-settings.json'),
    });
    try {
      assert.strictEqual(l3Enabled({}), false, '默认（env 未设）仍为关');
      process.env.MYTERMINAL_L3_ENABLED = '1';
      // 模拟新进程门闩（真实参与者是独立进程，门闩不共享）；leader 遗留 health 同样清掉
      resetL3Warmup();
      resetL3Health();
      // 触发面：startL3Warmup 读 process.env → env 开 → 预热（这里直接调以隔离验证 env 覆盖；
      // server.start 的触发由 AC1/AC5 覆盖）
      startL3Warmup(() => {});
      await pollUntil(() => l3Health()?.status === 'ready', 'env 强制开 → 预热触发', 3000);
      assert.strictEqual(l3Enabled({ MYTERMINAL_L3_ENABLED: '1' }), true, 'env 显式开覆盖参与者默认');
    } finally {
      delete process.env.MYTERMINAL_L3_ENABLED;
      await participant.close();
    }
  } finally { await leader.close(); }
});

// ── AC4：port 0 standalone 零变化 ───────────────────────────────────────────

test('AC4: port 0 standalone 行为零变化（回归锁定：L3 默认开 + 预热触发）', async () => {
  injectFake();
  const server = await createRuntime(); // 默认 port 0 → standalone 分支
  try {
    assert.strictEqual(l3Enabled({}), true, 'standalone 默认开');
    await pollUntil(() => server.runtime.l3Health()?.status === 'ready', 'standalone 预热触发');
  } finally { await server.close(); }
});

// ── AC5：选举迁移 ───────────────────────────────────────────────────────────

test('AC5: 选举迁移 — leader 退出 → 新 leader L3 翻转开 + 惰性补触发预热', async () => {
  injectFake();
  const port = await findFreePort();
  // keepDirs：leader 退出时 participant 仍活跃且共享其 registry 目录（settingsPath），
  // 目录删除延后到本测试尾部统一清理。
  const leader = await createRuntime({ port }, { keepDirs: true });
  const participant = await createRuntime({
    port,
    settingsPath: path.join(leader.dirs.stateDir, 'test-settings.json'),
  });
  try {
    assert.strictEqual(l3Enabled({}), false, '参与者为默认关');
    // leader 退出（close 释放端口 + 清 leaderId；electionTimer 1.8s 周期轮询接管）
    await leader.close();
    // leader.close 的 resetL3Adapter 清掉注入 factory——participant 是独立进程语义，
    // 接管前重新注入（其懒加载 getL3Adapter 用新 factory）
    injectFake();
    await pollUntil(() => l3Enabled({}) === true, '参与者接管 → L3 翻转开', 8000);
    // 接管点惰性补触发预热（close 已重置门闩 + health，新 leader 从 loading 重走状态机）
    await pollUntil(() => participant.runtime.l3Health()?.status === 'ready', '接管后惰性补预热', 8000);
  } finally {
    await participant.close();
    await leader.close();
    fs.rmSync(leader.dirs.workspaceDir, { recursive: true, force: true });
  }
});
