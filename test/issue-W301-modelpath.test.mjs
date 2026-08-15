// ADR-0051 W3-01 (#93)：l3ModelPath 解析链——env MYTERMINAL_L3_MODEL_PATH > 安装根 models 目录 > 裸文件名
//
// 验收断言：
//   AC1  env 设置时（即使安装根 models 目录同时存在模型）：路径 === env 值（最高优先）
//   AC2  env 未设置 + 安装根 models 目录存在默认模型：路径 === <安装根>/models/<默认模型>
//   AC3  两者皆无：回落裸文件名 DEFAULT_L3_MODEL_PATH（不再依赖 cwd 语义）
//   AC4  运行时探测：三种环境下 getL3Adapter 经注入 factory 拿到正确解析路径
//
// 测试方式：直接驱动 ../dist/l3/registry.js（build 产物）；env 经 process.env 注入/清空
// （withEnv 保存/还原，与 unit-resources.test.mjs installationRoot 用例同模式）；
// 安装根经 MYTERMINAL_HOME 指向 mkdtemp 临时目录（禁绝对路径字面量）。

import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_L3_MODEL_PATH,
  l3ModelPath,
  registerAdapterFactory,
  getL3Adapter,
  resetL3Adapter, resetL3AdapterInstance,
} from '../dist/l3/registry.js';

/** 最小 fake adapter（AC4 路径捕获用；与 issue-37 fakeAdapter 同构）。 */
function fakeAdapter() {
  return {
    id: 'fake',
    supportsStructuredOutput: true,
    isReady: async () => true,
    complete: async (req) => ({ object: { extracted: true }, finishReason: 'stop', latencyMs: 1, modelId: 'fake' }),
  };
}

afterEach(() => resetL3AdapterInstance()); // #101：只清单例保留 factory（bun 共享 worker 防跨文件清注入）

// ── env 保存/还原工具（value=undefined → 删除该变量）────────────────────────

function withEnv(patch, fn) {
  const saved = new Map();
  for (const key of Object.keys(patch)) saved.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** 临时安装根：root/models/<默认模型> 就位（模拟框架安装分发后的 models 目录）。 */
function makeInstallRoot(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'models'), { recursive: true });
  fs.writeFileSync(path.join(root, 'models', DEFAULT_L3_MODEL_PATH), '');
  return root;
}

/** AC4 探测：reset 后注入捕获路径的 factory，getL3Adapter 触发懒加载，返回 factory 收到的路径。 */
function probeResolvedPath() {
  let captured;
  const fake = fakeAdapter();
  resetL3Adapter(); // 注入前先全清（#101 隔离约定：先全清再注入）
  registerAdapterFactory((modelPath) => { captured = modelPath; return fake; });
  assert.strictEqual(getL3Adapter(), fake); // 注入生效
  return captured;
}

// ── AC1：env 最高优先 ────────────────────────────────────────────────────────

test('AC1 env 设置时路径 === env 值（覆盖安装根 models 目录）', () => {
  const root = makeInstallRoot('w301-ac1-');
  const envModel = path.join(root, 'env-model.gguf');
  fs.writeFileSync(envModel, '');
  try {
    withEnv({ MYTERMINAL_L3_MODEL_PATH: envModel, MYTERMINAL_HOME: root }, () => {
      assert.strictEqual(l3ModelPath(), envModel); // models 目录存在，env 仍优先
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC1 env 空串/空白视为未设置（回落下一档）', () => {
  const root = makeInstallRoot('w301-ac1b-');
  try {
    withEnv({ MYTERMINAL_L3_MODEL_PATH: '   ', MYTERMINAL_HOME: root }, () => {
      assert.strictEqual(l3ModelPath(), path.join(root, 'models', DEFAULT_L3_MODEL_PATH));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── AC2：安装根 models 目录 ──────────────────────────────────────────────────

test('AC2 env 未设置 + 安装根 models 存在默认模型 → 安装根 models 下路径', () => {
  const root = makeInstallRoot('w301-ac2-');
  try {
    withEnv({ MYTERMINAL_L3_MODEL_PATH: undefined, MYTERMINAL_HOME: root }, () => {
      assert.strictEqual(l3ModelPath(), path.join(root, 'models', DEFAULT_L3_MODEL_PATH));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC2 models 目录无默认模型文件 → 不命中安装根档', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w301-ac2b-'));
  fs.mkdirSync(path.join(root, 'models'), { recursive: true }); // 目录在，模型文件不在
  try {
    withEnv({ MYTERMINAL_L3_MODEL_PATH: undefined, MYTERMINAL_HOME: root }, () => {
      assert.strictEqual(l3ModelPath(), DEFAULT_L3_MODEL_PATH); // 回落裸文件名
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── AC3：两者皆无 → 裸文件名回落 ────────────────────────────────────────────

/** 临时 MYTERMINAL_HOME（无 models 目录 → 回落断言在任何机器确定化；#112 真模型环境加固）。 */
function withTempHome(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w301-home-'));
  try {
    withEnv({ MYTERMINAL_L3_MODEL_PATH: undefined, MYTERMINAL_HOME: root }, fn);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('AC3 env 未设置 + 无安装根 models → 回落 DEFAULT_L3_MODEL_PATH', () => {
  withTempHome(() => {
    assert.strictEqual(l3ModelPath(), DEFAULT_L3_MODEL_PATH);
  });
});

// ── AC4：getL3Adapter 运行时探测（factory 收到解析后路径）────────────────────

test('AC4 env 场景：getL3Adapter 拿到 env 路径', () => {
  const root = makeInstallRoot('w301-ac4a-');
  const envModel = path.join(root, 'env-model.gguf');
  fs.writeFileSync(envModel, '');
  try {
    withEnv({ MYTERMINAL_L3_MODEL_PATH: envModel, MYTERMINAL_HOME: root }, () => {
      assert.strictEqual(probeResolvedPath(), envModel);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC4 安装根 models 场景：getL3Adapter 拿到安装根路径', () => {
  const root = makeInstallRoot('w301-ac4b-');
  try {
    withEnv({ MYTERMINAL_L3_MODEL_PATH: undefined, MYTERMINAL_HOME: root }, () => {
      assert.strictEqual(probeResolvedPath(), path.join(root, 'models', DEFAULT_L3_MODEL_PATH));
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AC4 回落场景：getL3Adapter 拿到裸文件名', () => {
  withTempHome(() => {
    assert.strictEqual(probeResolvedPath(), DEFAULT_L3_MODEL_PATH);
  });
});
