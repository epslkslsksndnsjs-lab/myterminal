// ADR-0053 —— MyTerminal Onboarding 技能：onboard.mjs 纯逻辑锁
//
// 背景（ADR-0053，取代 ADR-0043）：
//   技能 skills/myterminal-onboarding/ 的「一条命令」是 scripts/onboard.mjs。
//   它做两类事：① 有副作用的（clone/build/写文件） ② 纯逻辑的（探测、校验、渲染、合并）。
//   本文件只锁 ②——纯函数，不 clone、不 build、不碰真实 HOME。
//
// 立锁纪律：
//   onboard.mjs 的纯逻辑必须与主仓事实逐字一致，主仓改了这里就该红。
//   五条事实源（本测试的真值来源，改主仓必须同步改这里）：
//     S1  src/config.ts:24-30            settingsPath 的三级回退 + optionalEnv 空串视为未设
//     S2  src/config.ts:110-120          applySubagentDefaults：六个可选字段默认值 + 范围
//     S3  src/config.ts:142-157          含遗留 provider 的 subagent 块整段静默忽略；
//                                         model/baseUrl/apiKey 三必填，缺一即拒
//     S4  src/subagent/llm-adapter.ts:294-295,364
//                                         baseUrl 归一化（剥末尾 / 与 /v1）；请求 URL=<baseUrl>/v1/messages
//     S5  src/l3/registry.ts:27,63       DEFAULT_L3_MODEL_PATH + <安装根>/models/ 落点
//
// 分区：
//   [LOCK-53-1] provider 全族 + profile 机制已连根删除（D1/D5，出口与 HELP 双面验证）
//   [LOCK-53-2] 配置路径解析复刻 settingsPath 三级回退
//   [LOCK-53-3] config 合并：三必填（model/baseUrl/apiKey）+ 删遗留 provider + 保留已有 + fallbackModel
//   [LOCK-53-4] 一切输出无明文 key：dry-run 草稿打码、写后回显只报布尔、探针只报 apiKeySet
//   [LOCK-53-5] keyless 连通性探测：401/403/2xx/异常/网络错，请求绝不携带 key
//   [LOCK-53-6] l3.recommend 阈值边界（磁盘 2GB / 内存 8GB，注入测试，永远带理由）
//   [LOCK-53-7] 可选字段不写入（默认值口径抄 applySubagentDefaults，防第二份默认值源）
//   [LOCK-53-8] config 可写性判定——绝不凭空造 config.json（否则把首次启动搞砖）
//   [LOCK-53-9] 入口守卫必须穿透符号链接
//   [LOCK-53-10] 首次运行设置界面引导：8 字段与必填清单逐字一致
//   [LOCK-53-11] 安装目录扫描扩展：候选目录 + 显式 --install-dir 优先
//   [LOCK-53-12] 构建完整性检查 + --force
//   [LOCK-53-13] 损坏 config 的 --repair 重置路径
//   [LOCK-53-14] 健康检查 --healthcheck
//   [LOCK-53-15] bun 版本解析与比较（数字比较，非字典序）
//   [LOCK-53-16] 探测报告形状：无 shell/apiKeysPresent/providers；config.subagent 只报
//                baseUrl/model/apiKeySet；机器只读事实 + l3.modelPresent
//   [LOCK-53-17] doWriteConfig 端到端：真实落盘 + 0600 + 备份 + app validateSettings 可接受
//   [LOCK-53-18] 磁盘事实探针目标退让：fresh 机器首次 --json 也必须报出字节数（R1）
//
// 变异体清单：
//   N1  provider 概念复活（SUPPORTED_PROVIDERS 回来）              → LOCK-53-1 杀
//   N2  merge 时把遗留 provider 字段留在输出里（app 整段静默忽略）  → LOCK-53-3 杀
//   N3  dry-run 草稿里带明文 key                                    → LOCK-53-4 杀
//   N4  探测请求带上 Authorization/x-api-key                        → LOCK-53-5 杀
//   N5  l3.recommend 阈值漂移（<2GB 却 install / =2GB 却 skip）      → LOCK-53-6 杀
//   N6  技能端自己写可选字段默认值（第二份默认值源，漂移病复发）      → LOCK-53-7 杀
//   N7  config 不存在时凭空写一份只有 subagent 段的                  → LOCK-53-8 杀（会砖首次启动）
//   N8  入口守卫用 argv[1] 直接比 import.meta.url，
//       经符号链接调用时静默不执行（命令哑火）                      → LOCK-53-9 杀
//   N9  版本比较用字符串，1.10.0 < 1.3.0                            → LOCK-53-15 杀
//   N10 --json 报告里 config.subagent 带出 apiKey 明文              → LOCK-53-4/53-16 杀
//   N11 --write-config 产出含 provider 的块（validateSettings 拒/忽略） → LOCK-53-17 杀

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateSettings } from '../dist/config.js';

import {
  normalizeBaseUrl,
  nearestExistingAncestor,
  mergeSubagentConfig,
  probeEndpoint,
  recommendL3,
  L3_RECOMMEND_THRESHOLDS,
  detectL3ModelPresent,
  L3_MODEL_FILENAME,
  SUBAGENT_OPTIONAL_FIELDS,
  resolveConfigPath,
  parseBunVersion,
  satisfiesMinVersion,
  assessConfigWritability,
  repairConfig,
  checkHealth,
  doWriteConfig,
  lookupInstallDir,
  INSTALL_CANDIDATE_DIRS,
  shouldRebuild,
  detect,
  FIRST_RUN_FIELDS,
  REQUIRED_CONFIG_FIELDS,
} from '../skills/myterminal-onboarding/scripts/onboard.mjs';

/** 一份「真实合法」的 config 骨架，字段照抄 validateSettings 的必填清单。 */
function validBaseConfig(extra = {}) {
  return {
    schemaVersion: 1,
    workspaceDir: '/home/tester/work',
    host: '127.0.0.1',
    port: 8787,
    publicBaseUrl: 'http://localhost:8787',
    connectorKey: 'x'.repeat(32),
    actionsToken: 'y'.repeat(32),
    maxOutputChars: 20000,
    commandTimeoutSec: 120,
    uiLanguage: 'zh-CN',
    uiTheme: 'dark',
    passiveLockEnabled: false,
    actionsContinuationMode: 'off',
    nonBlockingTasksEnabled: false,
    ...extra,
  };
}

/** 捕获 process.stdout.write 的辅助。 */
function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(s); return true; };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

// ═══════════════════════════════════════════════
// [LOCK-53-1] provider 全族 + profile 机制已删除（D1/D5）
//   真值：ADR-0053 D1（SUPPORTED_PROVIDERS/validateProvider/MODEL_PREFIXES/
//   PROVIDER_MODEL_KEYWORDS/VERIFY_ENDPOINTS 全删）与 D5（detectShellProfile/
//   buildExportLine/buildBaseUrlLine/BASE_URL_ENV/appendProfileBlock/PROFILE_MARKER_*
//   全退役）。旧机制在就是技能没迁移干净——输出出口也必须不带旧 flag。
// ═══════════════════════════════════════════════

describe('[LOCK-53-1] provider 族 + profile 机制连根删除', () => {
  const DELETED = [
    'SUPPORTED_PROVIDERS', 'validateProvider', 'MODEL_PREFIXES',
    'PROVIDER_MODEL_KEYWORDS', 'VERIFY_ENDPOINTS', 'verifyProviderKey',
    'detectShellProfile', 'buildExportLine', 'buildBaseUrlLine', 'BASE_URL_ENV',
    'appendProfileBlock', 'PROFILE_MARKER_BEGIN', 'PROFILE_MARKER_END', 'doKey',
  ];

  test('14 个旧出口全部不存在（N1 杀手锁）', async () => {
    const onboard = await import('../skills/myterminal-onboarding/scripts/onboard.mjs');
    for (const name of DELETED) {
      assert.equal(onboard[name], undefined, `${name} 应已随 ADR-0053 删除`);
    }
  });

  test('HELP 不再出现旧 flag（--provider/--verify/--write-profile/DASHSCOPE_BASE_URL）', async () => {
    const onboard = await import('../skills/myterminal-onboarding/scripts/onboard.mjs');
    const help = onboard.HELP || '';
    assert.ok(!help.includes('--provider'), 'HELP 不应再有 --provider');
    assert.ok(!help.includes('--verify'), 'HELP 不应再有 --verify');
    assert.ok(!help.includes('--write-profile'), 'HELP 不应再有 --write-profile');
    assert.ok(!help.includes('DASHSCOPE_BASE_URL'), 'HELP 不应再有 base-url 覆盖导出');
  });

  test('HELP 提供新命令（--write-config --base-url/--model/--key -、--probe）', async () => {
    const onboard = await import('../skills/myterminal-onboarding/scripts/onboard.mjs');
    const help = onboard.HELP || '';
    assert.ok(help.includes('--write-config'));
    assert.ok(help.includes('--base-url'));
    assert.ok(help.includes('--key -'));
    assert.ok(help.includes('--probe'));
  });
});

// ═══════════════════════════════════════════════
// [LOCK-53-2] 配置路径解析（复刻 src/config.ts settingsPath）
// ═══════════════════════════════════════════════

describe('[LOCK-53-2] resolveConfigPath 复刻 settingsPath 三级回退', () => {
  const HOME = '/home/tester';

  test('默认：$HOME/.config/myterminal/config.json', () => {
    assert.equal(
      resolveConfigPath({}, HOME),
      path.join(HOME, '.config', 'myterminal', 'config.json'),
    );
  });

  test('XDG_CONFIG_HOME 优先于 $HOME/.config', () => {
    assert.equal(
      resolveConfigPath({ XDG_CONFIG_HOME: '/xdg' }, HOME),
      path.join('/xdg', 'myterminal', 'config.json'),
    );
  });

  // Windows 上 '/custom/dir' 是「盘符相对」路径，src/config.ts:26 的 path.resolve(configured)
  // 会补上当前盘符（→ D:\custom\dir）——这是 Node 的正常语义，不是缺陷。
  // 断言输入必须给一条各平台都真正绝对的路径，否则 windows-latest 上假红。
  const CUSTOM_DIR = process.platform === 'win32' ? 'C:\\custom\\dir' : '/custom/dir';

  test('MYTERMINAL_CONFIG_DIR 最高优先，且不再追加 myterminal 段', () => {
    assert.equal(
      resolveConfigPath({ MYTERMINAL_CONFIG_DIR: CUSTOM_DIR, XDG_CONFIG_HOME: '/xdg' }, HOME),
      path.join(CUSTOM_DIR, 'config.json'),
    );
  });

  test('空串/纯空白视为未设（对齐 optionalEnv 的 trim 语义）', () => {
    assert.equal(
      resolveConfigPath({ MYTERMINAL_CONFIG_DIR: '   ', XDG_CONFIG_HOME: '' }, HOME),
      path.join(HOME, '.config', 'myterminal', 'config.json'),
    );
  });
});

// ═══════════════════════════════════════════════
// [LOCK-53-3] config 合并（ADR-0053 D2：三必填 + 删遗留 provider + 不写可选字段）
// ═══════════════════════════════════════════════

describe('[LOCK-53-3] mergeSubagentConfig 三必填契约', () => {
  test('空配置 + 三必填 → 恰好 {model, baseUrl, apiKey}，一个不多一个不少（N6 杀手锁）', () => {
    const out = mergeSubagentConfig({}, { baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-20241022', apiKey: 'sk-x' });
    assert.deepEqual(out.subagent, {
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: 'sk-x',
    });
  });

  test('遗留 provider 字段被删除（N2 杀手锁——app 会整段静默忽略，config.ts:142-147）', () => {
    const existing = { subagent: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-old', baseUrl: 'https://api.openai.com/v1' } };
    const out = mergeSubagentConfig(existing, { model: 'gpt-4o' });
    assert.equal('provider' in out.subagent, false, 'provider 字段必须绝迹——否则写出的 config 永不生效');
    assert.equal(out.subagent.model, 'gpt-4o');
  });

  test('用户已有字段不被吞（enabled/maxTurns 等原样保留，不再补默认）', () => {
    const existing = {
      subagent: { enabled: false, model: 'glm-4', baseUrl: 'https://x', apiKey: 'k', maxTurns: 12, timeoutSec: 60, fallbackModel: 'glm-4-flash' },
    };
    const out = mergeSubagentConfig(existing, { model: 'deepseek-chat' });
    assert.equal(out.subagent.model, 'deepseek-chat');
    assert.equal(out.subagent.baseUrl, 'https://x');
    assert.equal(out.subagent.apiKey, 'k');
    assert.equal(out.subagent.maxTurns, 12);
    assert.equal(out.subagent.timeoutSec, 60);
    assert.equal(out.subagent.fallbackModel, 'glm-4-flash');
    assert.equal(out.subagent.enabled, false, 'enabled 是用户显式选择，不许被默认值改写');
  });

  test('遗留 key 别名（api_key/key/token/secret）被剥离，apiKey 是唯一正规字段', () => {
    const existing = { subagent: { apiKey: 'sk-real', api_key: 'sk-a', key: 'sk-b', token: 'sk-c', secret: 'sk-d' } };
    const out = mergeSubagentConfig(existing, { model: 'm', baseUrl: 'https://x' });
    assert.equal(out.subagent.apiKey, 'sk-real');
    assert.equal('api_key' in out.subagent, false);
    assert.equal('key' in out.subagent, false);
    assert.equal('token' in out.subagent, false);
    assert.equal('secret' in out.subagent, false);
  });

  test('新 key 覆盖旧 key；空 key 视为未给（保留已有）', () => {
    const withOld = mergeSubagentConfig({ subagent: { apiKey: 'sk-old' } }, { model: 'm', baseUrl: 'https://x', apiKey: 'sk-new' });
    assert.equal(withOld.subagent.apiKey, 'sk-new');
    const kept = mergeSubagentConfig({ subagent: { apiKey: 'sk-old' } }, { model: 'm', baseUrl: 'https://x', apiKey: '' });
    assert.equal(kept.subagent.apiKey, 'sk-old');
  });

  test('config 里 subagent 之外的段落原样保留', () => {
    const existing = { schemaVersion: 1, workspaces: [{ name: 'w1' }], theme: 'dark' };
    const out = mergeSubagentConfig(existing, { baseUrl: 'https://x', model: 'm', apiKey: 'k' });
    assert.equal(out.schemaVersion, 1);
    assert.deepEqual(out.workspaces, [{ name: 'w1' }]);
    assert.equal(out.theme, 'dark');
  });

  test('纯函数：不改原对象', () => {
    const existing = { subagent: { provider: 'glm', model: 'glm-4' } };
    const snapshot = JSON.stringify(existing);
    mergeSubagentConfig(existing, { baseUrl: 'https://x', model: 'm', apiKey: 'k' });
    assert.equal(JSON.stringify(existing), snapshot);
  });

  test('三必填缺任一 → 抛错并点名（validateSettings 缺配即拒的同款纪律）', () => {
    assert.throws(() => mergeSubagentConfig({}, { baseUrl: 'https://x', model: 'm' }), /apiKey/);
    assert.throws(() => mergeSubagentConfig({}, { baseUrl: 'https://x', apiKey: 'k' }), /model/);
    assert.throws(() => mergeSubagentConfig({}, { model: 'm', apiKey: 'k' }), /baseUrl/);
    assert.throws(
      () => mergeSubagentConfig({}, {}),
      (err) => err instanceof Error && /model/.test(err.message) && /baseUrl/.test(err.message) && /apiKey/.test(err.message),
      '缺多个要一起点名，不能只报第一个',
    );
  });

  test('fallbackModel 透传：给则写、空串省略、已有保留', () => {
    const given = mergeSubagentConfig({}, { baseUrl: 'https://x', model: 'm', apiKey: 'k', fallbackModel: 'm-mini' });
    assert.equal(given.subagent.fallbackModel, 'm-mini');
    const omitted = mergeSubagentConfig({}, { baseUrl: 'https://x', model: 'm', apiKey: 'k', fallbackModel: '' });
    assert.equal('fallbackModel' in omitted.subagent, false);
    const kept = mergeSubagentConfig({ subagent: { fallbackModel: 'old-mini' } }, { baseUrl: 'https://x', model: 'm', apiKey: 'k' });
    assert.equal(kept.subagent.fallbackModel, 'old-mini');
  });
});

// ═══════════════════════════════════════════════
// [LOCK-53-4] 一切输出无明文 key（ADR-0053 D3）
//   覆盖三个输出面：--dry-run 草稿、写后回显、--json 报告。
// ═══════════════════════════════════════════════

describe('[LOCK-53-4] 任何输出都不出现明文 key', () => {
  const SECRET = 'sk-this-value-must-never-echo';

  function writeReport(cfgPath) {
    return { config: { path: cfgPath, exists: true } };
  }

  test('--dry-run 草稿打码：输出含 <redacted>，不含明文 key，且不落盘不备份（N3 杀手锁）', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adr53-redact-'));
    try {
      const cfgPath = path.join(dir, 'config.json');
      const before = JSON.stringify(validBaseConfig());
      writeFileSync(cfgPath, before, 'utf8');
      const out = captureStdout(() => {
        doWriteConfig(writeReport(cfgPath), {
          baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-20241022', key: SECRET, dryRun: true,
        });
      });
      assert.ok(out.includes('<redacted>'), '草稿应显式打码');
      assert.equal(out.includes(SECRET), false, '草稿不得带明文 key');
      assert.equal(readFileSync(cfgPath, 'utf8'), before, 'dry-run 不得写盘');
      assert.equal(existsSync(`${cfgPath}.myterminal-backup`), false, 'dry-run 不得生成备份');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('写后回显只报布尔：输出不含明文 key，含 "set (value never echoed)"（N3 杀手锁）', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adr53-echo-'));
    try {
      const cfgPath = path.join(dir, 'config.json');
      writeFileSync(cfgPath, JSON.stringify(validBaseConfig()), 'utf8');
      const out = captureStdout(() => {
        doWriteConfig(writeReport(cfgPath), {
          baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-20241022', key: SECRET, dryRun: false,
        });
      });
      assert.equal(out.includes(SECRET), false, '回显不得带明文 key');
      assert.match(out, /set \(value never echoed\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--json 报告：config.subagent 只报 apiKeySet 布尔，序列化全文无 key（N10 杀手锁）', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adr53-json-'));
    try {
      // 造一个含真实 key 的 config，确认 detect 的报告把它降级成布尔
      const checkout = path.join(dir, 'code', 'myterminal');
      mkdirSync(path.join(checkout, 'dist'), { recursive: true });
      writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'myterminal' }));
      writeFileSync(path.join(checkout, 'dist', 'cli.js'), '// built');
      const cfgDir = path.join(dir, '.config', 'myterminal');
      mkdirSync(cfgDir, { recursive: true });
      const cfgPath = path.join(cfgDir, 'config.json');
      writeFileSync(cfgPath, JSON.stringify(validBaseConfig({ subagent: { model: 'm', baseUrl: 'https://x', apiKey: SECRET } })), 'utf8');

      const report = detect({ homedir: dir, env: {} });
      const serialized = JSON.stringify(report);
      assert.equal(serialized.includes(SECRET), false, 'JSON 报告不得带明文 key');
      assert.equal(report.config.subagent.apiKeySet, true);
      assert.equal('apiKey' in report.config.subagent, false, '报告不得携带 apiKey 属性');
      assert.equal(report.config.subagent.model, 'm');
      assert.equal(report.config.subagent.baseUrl, 'https://x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════
// [LOCK-53-5] keyless 连通性探测（ADR-0053 D4）
//   真值：src/subagent/llm-adapter.ts:294-295,364 —— baseUrl 归一化 + <base>/v1/messages。
//   请求绝不携带 key：无 Authorization、无 x-api-key、body 无 key。fetchImpl 注入锁。
// ═══════════════════════════════════════════════

describe('[LOCK-53-5] probeEndpoint keyless 连通性探测', () => {
  function fakeFetch(status, { throws = false } = {}) {
    const calls = [];
    const impl = async (url, opts) => {
      calls.push({ url, opts });
      if (throws) throw new Error('ECONNREFUSED');
      return { status, ok: status >= 200 && status < 300 };
    };
    return { calls, impl };
  }

  test('401 → ok（端点可达、要求鉴权——正是 keyless 探测的期望答案）', async () => {
    const { calls, impl } = fakeFetch(401);
    const r = await probeEndpoint('https://api.anthropic.com', { fetchImpl: impl });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'auth-required');
    assert.equal(r.status, 401);
    assert.match(r.message, /401/);
    assert.equal(calls.length, 1);
  });

  test('403 → ok（同一语义）', async () => {
    const { impl } = fakeFetch(403);
    const r = await probeEndpoint('https://x', { fetchImpl: impl });
    assert.equal(r.ok, true);
    assert.equal(r.status, 403);
  });

  test('2xx → ok（无鉴权端点，本地服务器常见）', async () => {
    const { impl } = fakeFetch(200);
    const r = await probeEndpoint('https://localhost:11434', { fetchImpl: impl });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'open');
    assert.equal(r.status, 200);
  });

  test('其它 HTTP 状态 → ok=false 但 reachable=true（端点可达、应答异常）', async () => {
    const { impl } = fakeFetch(500);
    const r = await probeEndpoint('https://x', { fetchImpl: impl });
    assert.equal(r.ok, false);
    assert.equal(r.reachable, true);
    assert.equal(r.status, 500);
  });

  test('网络错误 → ok=false status=0，不抛（N4 语义：无 key 也就不该有 key 相关错误）', async () => {
    const { impl } = fakeFetch(0, { throws: true });
    const r = await probeEndpoint('https://x', { fetchImpl: impl });
    assert.equal(r.ok, false);
    assert.equal(r.reachable, false);
    assert.equal(r.status, 0);
    assert.match(r.message, /Network error/);
  });

  test('请求构造：<baseUrl>/v1/messages，无任何鉴权头，body 无 key（N4 杀手锁）', async () => {
    const { calls, impl } = fakeFetch(401);
    await probeEndpoint('https://api.anthropic.com', { fetchImpl: impl });
    const { url, opts } = calls[0];
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(opts.headers.authorization, undefined, '绝不允许 Authorization 头');
    assert.equal(opts.headers['x-api-key'], undefined, '绝不允许 x-api-key 头');
    const body = JSON.parse(opts.body);
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('sk-'), false, 'body 不得含任何 key');
  });

  test('baseUrl 归一化与 app 一致：剥末尾 / 与 /v1（真值 llm-adapter.ts:294-295）', async () => {
    assert.equal(normalizeBaseUrl('https://api.anthropic.com'), 'https://api.anthropic.com');
    assert.equal(normalizeBaseUrl('https://api.anthropic.com/'), 'https://api.anthropic.com');
    assert.equal(normalizeBaseUrl('https://api.anthropic.com/v1'), 'https://api.anthropic.com');
    assert.equal(normalizeBaseUrl('https://api.anthropic.com/v1/'), 'https://api.anthropic.com');
    const { calls, impl } = fakeFetch(401);
    await probeEndpoint('https://gateway.example/v1/', { fetchImpl: impl });
    assert.equal(calls[0].url, 'https://gateway.example/v1/messages');
  });

  test('空 baseUrl → ok=false kind=no-base-url，不打请求', async () => {
    const impl = async () => assert.fail('不应发起请求');
    const r = await probeEndpoint('', { fetchImpl: impl });
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'no-base-url');
  });
});

// ═══════════════════════════════════════════════
// [LOCK-53-6] l3.recommend 阈值边界（ADR-0053 D7）
//   可用磁盘 < 2GB → skip；总内存 < 8GB → skip；否则 install。永远带理由。
// ═══════════════════════════════════════════════

describe('[LOCK-53-6] recommendL3 阈值边界（注入测试）', () => {
  const GB = 1024 ** 3;

  test('阈值常量固定为 2GB / 8GB（N5 杀手锁：改阈值必须改这里）', () => {
    assert.deepEqual(L3_RECOMMEND_THRESHOLDS, { minFreeDiskBytes: 2 * GB, minTotalMemoryBytes: 8 * GB });
  });

  test('磁盘边界：正好 2GB → install；2GB-1 → skip', () => {
    assert.equal(recommendL3({ freeDiskBytes: 2 * GB, totalMemoryBytes: 8 * GB }).verdict, 'install');
    assert.equal(recommendL3({ freeDiskBytes: 2 * GB - 1, totalMemoryBytes: 8 * GB }).verdict, 'skip');
  });

  test('内存边界：正好 8GB → install；8GB-1 → skip', () => {
    assert.equal(recommendL3({ freeDiskBytes: 2 * GB, totalMemoryBytes: 8 * GB }).verdict, 'install');
    assert.equal(recommendL3({ freeDiskBytes: 2 * GB, totalMemoryBytes: 8 * GB - 1 }).verdict, 'skip');
  });

  test('两个维度都满足才 install：任一不满足 → skip', () => {
    assert.equal(recommendL3({ freeDiskBytes: 2 * GB - 1, totalMemoryBytes: 8 * GB - 1 }).verdict, 'skip');
    assert.equal(recommendL3({ freeDiskBytes: 50 * GB, totalMemoryBytes: 7 * GB }).verdict, 'skip');
    assert.equal(recommendL3({ freeDiskBytes: 1 * GB, totalMemoryBytes: 64 * GB }).verdict, 'skip');
  });

  test('推荐永远带理由（ADR-0053 D7：是事实不是观点）', () => {
    const install = recommendL3({ freeDiskBytes: 50 * GB, totalMemoryBytes: 64 * GB });
    assert.equal(install.verdict, 'install');
    assert.ok(install.reasons.length >= 1);
    assert.match(install.reasons[0], /50\.0 GB/);
    const skip = recommendL3({ freeDiskBytes: 1 * GB, totalMemoryBytes: 64 * GB });
    assert.ok(skip.reasons.length >= 1);
    assert.match(skip.reasons[0], /1\.0 GB/);
  });

  test('测量缺失（磁盘不可测/内存不可测）→ 保守 skip 并说明原因', () => {
    assert.equal(recommendL3({ freeDiskBytes: null, totalMemoryBytes: 64 * GB }).verdict, 'skip');
    assert.equal(recommendL3({ freeDiskBytes: 50 * GB, totalMemoryBytes: null }).verdict, 'skip');
    assert.equal(recommendL3({}).verdict, 'skip');
    const r = recommendL3({ freeDiskBytes: null, totalMemoryBytes: 64 * GB });
    assert.ok(r.reasons.some((x) => x.includes('could not be measured')));
  });
});

// ═══════════════════════════════════════════════
// [LOCK-53-7] 可选字段不写入（ADR-0053 D2/F7）
//   真值：src/config.ts:110-120 applySubagentDefaults —— 技能端不留第二份默认值源。
// ═══════════════════════════════════════════════

describe('[LOCK-53-7] 可选字段默认值口径抄 applySubagentDefaults', () => {
  const TRUTH = [
    { field: 'maxTurns', default: 50, min: 1, max: 200 },
    { field: 'timeoutSec', default: 300, min: 30, max: 3600 },
    { field: 'maxParallel', default: 2, min: 1, max: 4 },
    { field: 'contextWindow', default: 120_000, min: 1_000, max: 1_000_000 },
    { field: 'maxOutput', default: 32_000, min: 1_000, max: 200_000 },
    { field: 'compactThreshold', default: 80_000, min: 1_000, max: 500_000 },
  ];

  test('SUBAGENT_OPTIONAL_FIELDS 与 applySubagentDefaults 逐字一致（N6 杀手锁）', () => {
    assert.deepEqual(SUBAGENT_OPTIONAL_FIELDS, TRUTH);
  });

  test('merge 不写可选字段（空配置 → 输出无 maxTurns 等任何默认值注入）', () => {
    const out = mergeSubagentConfig({}, { baseUrl: 'https://x', model: 'm', apiKey: 'k' });
    assert.deepEqual(Object.keys(out.subagent).sort(), ['apiKey', 'baseUrl', 'model']);
  });

  test('merge 对用户已配置的可选字段原样保留', () => {
    const existing = { subagent: { maxTurns: 12, contextWindow: 999_000, model: 'm', baseUrl: 'https://x', apiKey: 'k' } };
    const out = mergeSubagentConfig(existing, {});
    assert.equal(out.subagent.maxTurns, 12);
    assert.equal(out.subagent.contextWindow, 999_000);
  });
});

// ═══════════════════════════════════════════════
// [LOCK-53-8] config 可写性判定
//
// 为什么这把锁必须存在（主仓事实）：
//   src/config.ts:parseMyTerminalSettings —— schemaVersion !== 1 直接 throw
//   src/config.ts:validateSettings       —— workspaceDir/host/port/publicBaseUrl/
//                                                connectorKey(>=24)/actionsToken(>=24)/
//                                                maxOutputChars/commandTimeoutSec 全部必填
//   src/cli.ts:ensureSettings            —— 注释写死「配置无效时绝不回退到首次运行默认值，
//                                                因为那会悄悄替换稳定凭据」→ 直接抛错
//
// 推论：onboard 若在 config.json 不存在时凭空写一份只有 subagent 段的文件，
//       用户首次启动会 throw，而且再也走不进 setup TUI —— 等于把安装搞砖。
//       连接器凭据是随机 32 字节，脚本没资格伪造。
//       正确做法：让用户先跑一次 MyTerminal 完成 setup TUI，再回来写 subagent。
// ═══════════════════════════════════════════════

describe('[LOCK-53-8] assessConfigWritability 绝不凭空造 config', () => {
  test('config 不存在 → 拒写，并指引先跑一次 setup（N7 杀手锁）', () => {
    const r = assessConfigWritability(null);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing');
    // 必须给出可执行的下一步，而不是干巴巴报错
    assert.match(r.guidance, /bun run dev/);
    // 必须解释为什么脚本不能自己造
    assert.match(r.guidance, /credential/i);
    // 指引里的重跑命令必须是新契约（--base-url/--key -，不再是 --provider）
    assert.match(r.guidance, /--base-url/);
    assert.match(r.guidance, /--key -/);
    assert.ok(!r.guidance.includes('--provider'));
  });

  test('config 是坏 JSON → 拒写，不覆盖用户文件', () => {
    const r = assessConfigWritability({ __parseError: 'Unexpected token }' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unparsable');
  });

  test('schemaVersion 不是 1 → 拒写（主仓会 throw）', () => {
    assert.equal(assessConfigWritability(validBaseConfig({ schemaVersion: 2 })).reason, 'unsupported-schema');
    const noVersion = validBaseConfig();
    delete noVersion.schemaVersion;
    assert.equal(assessConfigWritability(noVersion).reason, 'unsupported-schema');
  });

  test('schemaVersion 对但必填字段缺失 → 拒写，并点名缺了哪几个', () => {
    const broken = validBaseConfig();
    delete broken.connectorKey;
    delete broken.actionsToken;
    const r = assessConfigWritability(broken);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'incomplete');
    assert.ok(r.missing.includes('connectorKey'));
    assert.ok(r.missing.includes('actionsToken'));
  });

  test('完整合法 config → 放行', () => {
    const r = assessConfigWritability(validBaseConfig());
    assert.equal(r.ok, true);
  });
});

// ═══════════════════════════════════════════════
// [LOCK-53-9] 入口守卫必须穿透符号链接
//
// 为什么这把锁必须存在：
//   脚本可能被一条符号链接调用（例如用户把它软链到 PATH 上命名为 `myterminal-onboard`）。
//   而 import.meta.url 给的是**解析后的真实路径**，process.argv[1] 给的是**符号链接路径**，
//   两者直接字符串比较必然不等 → main() 不执行 → 命令静默无输出。
//   实测踩过：早期 `isInvokedDirectly` 用字符串比较时，node 下经符号链接调用 `--help` 什么都不打印。
// ═══════════════════════════════════════════════

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills',
  'myterminal-onboarding',
  'scripts',
  'onboard.mjs',
);

// 必须逐个运行时验证：node 会把 import.meta.url 解析成真实路径，bun 不会。
// 只在 bun（测试运行时）下测，这个 bug 测不出来——实测 node 0 行输出、bun 26 行。
// 真实触发链是经符号链接 + node shebang 调用，node 是必测项。
function availableRuntimes() {
  const runtimes = [{ name: 'test-runtime', bin: process.execPath }];
  try {
    execFileSync('node', ['--version'], { stdio: 'ignore' });
    runtimes.push({ name: 'node', bin: 'node' });
  } catch {
    // 脚本依赖 node；此处缺失只降级为不测，不误报红。
  }
  return runtimes;
}

const RUNTIMES = availableRuntimes();

describe('[LOCK-53-9] 经符号链接调用仍会执行', () => {
  test('node 必须可用——脚本与 shebang 都依赖它', () => {
    assert.ok(
      RUNTIMES.some((r) => r.name === 'node'),
      'node 不在 PATH 上，这条锁形同虚设（本机应装 node）',
    );
  });

  for (const runtime of RUNTIMES) {
    test(`[${runtime.name}] 直接路径调用有输出（基线）`, () => {
      const out = execFileSync(runtime.bin, [SCRIPT_PATH, '--help'], { encoding: 'utf8' });
      assert.match(out, /USAGE/);
    });

    test(`[${runtime.name}] 经符号链接调用同样有输出（N8 杀手锁）`, () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'mt-onboard-link-'));
      try {
        const link = path.join(dir, 'myterminal-onboard');
        symlinkSync(SCRIPT_PATH, link);
        const out = execFileSync(runtime.bin, [link, '--help'], { encoding: 'utf8' });
        assert.match(out, /USAGE/, `${runtime.name} 经符号链接调用时 main() 没有执行——命令哑火`);
        assert.match(out, /onboard\.mjs/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`[${runtime.name}] 被 import 时绝不自动执行（修 N8 不能变成一 import 就跑）`, () => {
      // 必须走 file URL：Windows 上 SCRIPT_PATH 含反斜杠，直接插进模板字符串会被 JS
      // 当转义序列吃掉（\a\m\s → amsss），运行时报 Cannot find package 'D:amyterminal...'。
      // pathToFileURL 产出正斜杠 + 百分号编码，JSON.stringify 再兜一层引号安全。
      const probe = `import(${JSON.stringify(pathToFileURL(SCRIPT_PATH).href)}).then(() => process.stdout.write('IMPORTED_QUIET'));`;
      const out = execFileSync(runtime.bin, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
      assert.equal(out.trim(), 'IMPORTED_QUIET', 'import 时不该有任何额外输出');
    });
  }
});

// ═══════════════════════════════════════════════
// [LOCK-53-10] 首次运行设置界面引导
//
// 为什么这把锁必须存在（用户评审 P0）：
//   旧 FIRST_RUN_GUIDANCE 只说"run bun run dev"，首次使用者面对空屏不知填啥。
//   这 8 个字段就是 validateSettings 的必填清单，必须显式列出来且和
//   REQUIRED_CONFIG_FIELDS 逐字一致——少一个、错一个名字，引导就骗人。
// ═══════════════════════════════════════════════

describe('[LOCK-53-10] 首次运行设置界面引导', () => {
  test('FIRST_RUN_FIELDS 正好是 8 个，与 REQUIRED_CONFIG_FIELDS 逐字一致', () => {
    assert.equal(FIRST_RUN_FIELDS.length, 8);
    const names = FIRST_RUN_FIELDS.map((f) => f.field).sort();
    const required = [...REQUIRED_CONFIG_FIELDS].sort();
    assert.deepEqual(names, required, '首跑引导字段必须与 validateSettings 必填清单完全一致');
  });

  test('每个字段都带人类可读说明（不能只甩个变量名）', () => {
    for (const f of FIRST_RUN_FIELDS) {
      assert.equal(typeof f.field, 'string');
      assert.ok(f.what && f.what.length > 4, `字段 ${f.field} 缺少可读说明`);
    }
  });
});

// ═══════════════════════════════════════════════
// [LOCK-53-11] 安装目录扫描扩展
// ═══════════════════════════════════════════════

describe('[LOCK-53-11] 安装目录扫描扩展', () => {
  function fakeCheckout(root, rel) {
    const dir = path.join(root, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'myterminal' }));
    return dir;
  }
  function decoy(root, rel) {
    const dir = path.join(root, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'something-else' }));
    return dir;
  }

  test('INSTALL_CANDIDATE_DIRS 含 projects/code/dev 等标准位置', () => {
    for (const rel of ['projects/myterminal', 'code/myterminal', 'dev/myterminal', 'Desktop/myterminal']) {
      assert.ok(INSTALL_CANDIDATE_DIRS.includes(rel), `候选目录缺 ${rel}`);
    }
  });

  test('在 ~/projects/myterminal 找到 checkout，不误判未安装', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-homedir-'));
    try {
      decoy(root, 'myterminal'); // ~/myterminal 是别的仓库，不应被误认
      const found = fakeCheckout(root, 'projects/myterminal');
      const result = lookupInstallDir(root, undefined);
      assert.equal(result, found, '应在 projects/myterminal 找到，而非误判未安装');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('显式 --install-dir 优先于候选目录', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-installdir-'));
    try {
      const explicit = fakeCheckout(root, 'custom/location');
      const result = lookupInstallDir(root, explicit);
      assert.equal(result, explicit);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('完全不存在时返回 null（不是空串/假值坑）', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-empty-'));
    try {
      assert.equal(lookupInstallDir(root, undefined), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detect 对装在非默认目录的 checkout 报告 installed=true 且 suggestedInstallDir 指向它', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-detect-'));
    try {
      const found = fakeCheckout(root, 'code/myterminal');
      const report = detect({ installDir: undefined, homedir: root, env: {} });
      assert.equal(report.myterminal.installed, true);
      assert.equal(report.myterminal.installDir, found);
      assert.equal(report.myterminal.suggestedInstallDir, found, 'suggestedInstallDir 应指向已找到的真实目录');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════
// [LOCK-53-12] 构建完整性检查 + --force
// ═══════════════════════════════════════════════

describe('[LOCK-53-12] 构建完整性检查 + --force', () => {
  function setMtime(file, ms) {
    utimesSync(file, new Date(ms), new Date(ms));
  }

  function freshLayout(root) {
    mkdirSync(path.join(root, 'dist'), { recursive: true });
    mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{}');
    writeFileSync(path.join(root, 'dist', 'cli.js'), '// built');
    return root;
  }

  test('force=true → 必然重建', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-build-'));
    try {
      freshLayout(root);
      assert.equal(shouldRebuild(root, { force: true }), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('dist/cli.js 缺失 → 重建', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-build-'));
    try {
      mkdirSync(path.join(root, 'node_modules'), { recursive: true });
      writeFileSync(path.join(root, 'package.json'), '{}');
      assert.equal(shouldRebuild(root, {}), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('node_modules 缺失（cli.js 在）→ 重建（修半坏构建）', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-build-'));
    try {
      mkdirSync(path.join(root, 'dist'), { recursive: true });
      writeFileSync(path.join(root, 'dist', 'cli.js'), '// built');
      assert.equal(shouldRebuild(root, {}), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cli.js 比 package.json 旧（产物过期）→ 重建', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-build-'));
    try {
      freshLayout(root);
      const base = 1_700_000_000_000;
      setMtime(path.join(root, 'src'), base);                    // 旧
      setMtime(path.join(root, 'dist', 'cli.js'), base);          // 旧
      setMtime(path.join(root, 'package.json'), base + 60_000);   // 新
      assert.equal(shouldRebuild(root, {}), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('cli.js 比 package.json 新且 node_modules 在 → 不重建', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-build-'));
    try {
      freshLayout(root);
      const base = 1_700_000_000_000;
      setMtime(path.join(root, 'src'), base);                    // 旧
      setMtime(path.join(root, 'package.json'), base);            // 旧
      setMtime(path.join(root, 'dist', 'cli.js'), base + 60_000); // 新
      assert.equal(shouldRebuild(root, {}), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════
// [LOCK-53-13] 损坏 config 的 --repair 重置路径
// ═══════════════════════════════════════════════

describe('[LOCK-53-13] 损坏 config 的 --repair 重置路径', () => {
  function writeConfig(root, name, content) {
    const file = path.join(root, name);
    writeFileSync(file, content);
    return file;
  }
  function validConfig() {
    return JSON.stringify({
      schemaVersion: 1,
      workspaceDir: '/w', host: '127.0.0.1', port: 1, publicBaseUrl: 'x',
      connectorKey: 'a'.repeat(24), actionsToken: 'b'.repeat(24),
      maxOutputChars: 1, commandTimeoutSec: 1,
    });
  }

  test('健康 config → 不修复、不改动', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-repair-'));
    try {
      const file = writeConfig(root, 'config.json', validConfig());
      const r = repairConfig(file, {});
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'healthy');
      assert.ok(existsSync(file), '健康 config 应原封不动');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('坏 JSON → 备份并移除原文件', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-repair-'));
    try {
      const file = writeConfig(root, 'config.json', '{ this is not json');
      const r = repairConfig(file, {});
      assert.equal(r.ok, true);
      assert.ok(/repair-backup-/.test(r.backup), '应生成带时间戳的备份');
      assert.ok(existsSync(r.backup), '备份应存在');
      if (process.platform !== 'win32') {
        assert.equal(fs_statMode(r.backup), 0o600, 'repair 备份含凭据，必须 0600（R4）');
      }
      assert.equal(existsSync(file), false, '破损原文件应被移除');
      assert.match(r.message, /Re-run 'bun run dev'/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('缺字段（凭据丢失）的合法 JSON → 同样备份移除，让首跑重 mint', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-repair-'));
    try {
      const incomplete = JSON.stringify({ schemaVersion: 1, workspaceDir: '/w' });
      const file = writeConfig(root, 'config.json', incomplete);
      const r = repairConfig(file, {});
      assert.equal(r.ok, true);
      assert.equal(r.reason, 'incomplete');
      assert.equal(existsSync(file), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('--dry-run → 不删文件，只报告会做什么', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-repair-'));
    try {
      const file = writeConfig(root, 'config.json', '{ bad');
      const r = repairConfig(file, { dryRun: true });
      assert.equal(r.ok, true);
      assert.equal(r.dryRun, true);
      assert.ok(existsSync(file), 'dry-run 不应删除原文件');
      assert.equal(existsSync(r.backup), false, 'dry-run 不应生成备份');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('文件不存在 → 无可修复', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-repair-'));
    try {
      const r = repairConfig(path.join(root, 'nope.json'), {});
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'absent');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════
// [LOCK-53-14] 健康检查 --healthcheck
//   真值：src/server.ts 健康端点返回 200 + {product:'myterminal'}；
//        src/config.ts 握手同样认 product==='myterminal'；默认 host=127.0.0.1 port=3210。
//   纯函数 checkHealth 不碰网络/文件系统，fetchImpl 注入 mock。
// ═══════════════════════════════════════════════

function mockHealthFetch(body, { status = 200, throwErr = null } = {}) {
  return async (_url, _opts) => {
    if (throwErr) throw throwErr;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    };
  };
}

describe('[LOCK-53-14] 健康检查 --healthcheck', () => {
  test('200 + product=myterminal → ok:true / reachable:true', async () => {
    const r = await checkHealth({ fetchImpl: mockHealthFetch({ product: 'myterminal', ok: true }) });
    assert.equal(r.ok, true);
    assert.equal(r.reachable, true);
    assert.equal(r.status, 200);
    assert.equal(r.product, 'myterminal');
  });

  test('503 + product=myterminal → ok:false 但 reachable:true（运行中但降级）', async () => {
    const r = await checkHealth({ fetchImpl: mockHealthFetch({ product: 'myterminal', ok: false }, { status: 503 }) });
    assert.equal(r.ok, false);
    assert.equal(r.reachable, true);
    assert.equal(r.status, 503);
  });

  test('200 + product 不是 myterminal → ok:false / reachable:false（不是本服务）', async () => {
    const r = await checkHealth({ fetchImpl: mockHealthFetch({ product: 'some-other-app' }) });
    assert.equal(r.ok, false);
    assert.equal(r.reachable, false);
    assert.equal(r.product, 'some-other-app');
  });

  test('非 JSON 响应（json() 抛错）→ reachable:false / product:null / ok:false', async () => {
    const brokenFetch = async () => ({
      status: 200,
      ok: true,
      json: async () => { throw new Error('not json'); },
    });
    const r = await checkHealth({ fetchImpl: brokenFetch });
    assert.equal(r.ok, false);
    assert.equal(r.reachable, false);
    assert.equal(r.product, null);
  });

  test('网络错误（fetchImpl 抛错）→ ok:false / reachable:false / status:0', async () => {
    const r = await checkHealth({ fetchImpl: mockHealthFetch(null, { throwErr: new Error('ECONNREFUSED') }) });
    assert.equal(r.ok, false);
    assert.equal(r.reachable, false);
    assert.equal(r.status, 0);
    assert.match(r.message, /Cannot reach/);
  });

  test('自定义 host/port 拼出正确 URL（http://<host>:<port>/health）', async () => {
    let captured = null;
    const recFetch = async (url) => {
      captured = url;
      return { status: 200, ok: true, json: async () => ({ product: 'myterminal' }) };
    };
    const r = await checkHealth({ host: 'example.local', port: 9999, fetchImpl: recFetch });
    assert.equal(captured, 'http://example.local:9999/health');
    assert.equal(r.ok, true);
  });

  test('不传参数 → 默认 http://127.0.0.1:3210/health', async () => {
    let captured = null;
    const recFetch = async (url) => {
      captured = url;
      return { status: 200, ok: true, json: async () => ({ product: 'myterminal' }) };
    };
    await checkHealth({ fetchImpl: recFetch });
    assert.equal(captured, 'http://127.0.0.1:3210/health');
  });
});

// ═══════════════════════════════════════════════
// [LOCK-53-15] bun 版本（package.json engines: bun>=1.3.0）
// ═══════════════════════════════════════════════

describe('[LOCK-53-15] bun 版本解析与比较', () => {
  test('parseBunVersion 吃得下裸版本号与带前缀输出', () => {
    assert.equal(parseBunVersion('1.3.2\n'), '1.3.2');
    assert.equal(parseBunVersion('bun 1.3.2'), '1.3.2');
    assert.equal(parseBunVersion('1.3.2+abcdef\n'), '1.3.2');
  });

  test('parseBunVersion 对垃圾输入返回 null，不瞎猜', () => {
    assert.equal(parseBunVersion(''), null);
    assert.equal(parseBunVersion('command not found'), null);
    assert.equal(parseBunVersion(undefined), null);
  });

  test('satisfiesMinVersion 用数字比较，不是字典序（N9 杀手锁）', () => {
    assert.equal(satisfiesMinVersion('1.10.0', '1.3.0'), true);
    assert.equal(satisfiesMinVersion('1.3.0', '1.3.0'), true);
    assert.equal(satisfiesMinVersion('1.2.9', '1.3.0'), false);
    assert.equal(satisfiesMinVersion('2.0.0', '1.3.0'), true);
    assert.equal(satisfiesMinVersion('0.9.9', '1.3.0'), false);
  });

  test('版本段数不齐时按 0 补齐', () => {
    assert.equal(satisfiesMinVersion('2', '1.3.0'), true);
    assert.equal(satisfiesMinVersion('1.3', '1.3.0'), true);
    assert.equal(satisfiesMinVersion('1', '1.3.0'), false);
  });

  test('null 版本（bun 不存在）判为不满足', () => {
    assert.equal(satisfiesMinVersion(null, '1.3.0'), false);
  });
});

// ═══════════════════════════════════════════════
// [LOCK-53-16] 探测报告形状 + L3 本地模型存在性
//   真值：ADR-0053 D6（删 shell.*/apiKeysPresent/providers；config.subagent 只报
//   baseUrl/model/apiKeySet；增机器只读事实 + l3.recommend/l3.modelPresent）；
//   S5（registry.ts:27,63 —— models/ 下的固定文件名）。
// ═══════════════════════════════════════════════

describe('[LOCK-53-16] 探测报告形状与 l3.modelPresent', () => {
  test('L3_MODEL_FILENAME 与主仓 registry.ts:27 逐字一致', () => {
    assert.equal(L3_MODEL_FILENAME, 'Qwen3.5-2B-Q4_K_M.gguf');
  });

  test('报告无 shell/apiKeysPresent/providers 字段（N10/D6）', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-shape-'));
    try {
      const report = detect({ homedir: root, env: {} });
      assert.equal('shell' in report, false, 'shell.* 已退役（D5）');
      assert.equal('apiKeysPresent' in report, false, 'apiKeysPresent 已删除（D6）');
      assert.equal('providers' in report, false, 'providers 已删除（D6）');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('config.subagent 投影只含 baseUrl/model/apiKeySet 三键（N10 杀手锁）', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-proj-'));
    try {
      const checkout = path.join(root, 'myterminal');
      mkdirSync(path.join(checkout, 'dist'), { recursive: true });
      writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'myterminal' }));
      writeFileSync(path.join(checkout, 'dist', 'cli.js'), '// built');
      const cfgDir = path.join(root, '.config', 'myterminal');
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        path.join(cfgDir, 'config.json'),
        JSON.stringify(validBaseConfig({ subagent: { model: 'm', baseUrl: 'https://x', apiKey: 'sk-real' } })),
        'utf8',
      );
      const report = detect({ homedir: root, env: {} });
      assert.deepEqual(Object.keys(report.config.subagent).sort(), ['apiKeySet', 'baseUrl', 'model']);
      assert.equal(report.config.subagent.apiKeySet, true);
      assert.equal(report.config.subagent.model, 'm');
      assert.equal(report.config.subagent.baseUrl, 'https://x');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('机器只读事实：machine 有 platform/freeDiskBytes/totalMemoryBytes，l3.recommend 有 verdict+reasons', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-mach-'));
    try {
      const report = detect({ homedir: root, env: {} });
      assert.equal(typeof report.machine.platform, 'string');
      assert.ok(report.machine.freeDiskBytes === null || typeof report.machine.freeDiskBytes === 'number');
      assert.ok(typeof report.machine.totalMemoryBytes === 'number');
      assert.ok(['install', 'skip'].includes(report.l3.recommend.verdict));
      assert.ok(Array.isArray(report.l3.recommend.reasons) && report.l3.recommend.reasons.length >= 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('models/ 下有成品 gguf → modelPresent=true；只有 .part / 空目录 / 无 checkout → false', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-l3p-'));
    try {
      const checkout = path.join(root, 'myterminal');
      mkdirSync(path.join(checkout, 'models'), { recursive: true });
      // 无模型文件 → false
      assert.equal(detectL3ModelPresent(checkout), false);
      // 只有半成品 .part → false（下载未完成不算数）
      writeFileSync(path.join(checkout, 'models', `${L3_MODEL_FILENAME}.part`), 'partial');
      assert.equal(detectL3ModelPresent(checkout), false);
      // 成品落盘 → true
      writeFileSync(path.join(checkout, 'models', L3_MODEL_FILENAME), 'gguf');
      assert.equal(detectL3ModelPresent(checkout), true);
      // 无 checkout → false
      assert.equal(detectL3ModelPresent(null), false);
      assert.equal(detectL3ModelPresent('/definitely/not/here'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detect 报告里 l3.modelPresent 与实际 models 目录一致', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-l3d-'));
    try {
      const checkout = path.join(root, 'code', 'myterminal');
      mkdirSync(path.join(checkout, 'models'), { recursive: true });
      mkdirSync(path.join(checkout, 'dist'), { recursive: true });
      writeFileSync(path.join(checkout, 'package.json'), JSON.stringify({ name: 'myterminal' }));
      writeFileSync(path.join(checkout, 'dist', 'cli.js'), '// built');
      writeFileSync(path.join(checkout, 'models', L3_MODEL_FILENAME), 'gguf');
      const report = detect({ homedir: root, env: {} });
      assert.equal(report.myterminal.installDir, checkout);
      assert.equal(report.l3.modelPresent, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════
// [LOCK-53-18] 磁盘事实探针目标退让（审查 R1）
//   R1：readFreeDiskBytes 对 `foundDir ?? ~/myterminal` 直测，fresh 机器该目录
//   不存在 → ENOENT → null → l3.recommend 恒 skip「could not be measured」。
//   技能核心受众就是 fresh 机器——首次 --json 就报「未知」违背 D7。
//   修正：探针目标取最近存在的祖先目录（至少退到 homedir；显式 installDir 同理）。
// ═══════════════════════════════════════════════

describe('[LOCK-53-18] 磁盘探针目标退让（审查 R1）', () => {
  test('nearestExistingAncestor：幽灵路径退到最近存在祖先，存在路径返回自身', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-anc-'));
    try {
      mkdirSync(path.join(root, 'deep', 'nest'), { recursive: true });
      assert.equal(nearestExistingAncestor(root), root);
      assert.equal(nearestExistingAncestor(path.join(root, 'deep', 'nest')), path.join(root, 'deep', 'nest'));
      assert.equal(nearestExistingAncestor(path.join(root, 'deep', 'ghost')), path.join(root, 'deep'));
      assert.equal(nearestExistingAncestor(path.join(root, 'ghost', 'deeper')), root);
      assert.equal(nearestExistingAncestor(path.join(root, 'a', 'b', 'c')), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('根目录不死循环（盘符根/卷根即终点）', () => {
    const rootPath = path.parse(os.tmpdir()).root;
    assert.equal(nearestExistingAncestor(path.join(rootPath, 'x', 'y')), rootPath);
  });

  test('fresh 机器（无 checkout 无 ~/myterminal）：freeDiskBytes 必须是数字（R1 杀手锁）', () => {
    if (process.platform === 'win32') return; // statfs 仅 unix
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-r1-'));
    try {
      const report = detect({ homedir: root, env: {} });
      assert.equal(typeof report.machine.freeDiskBytes, 'number', 'fresh 机器首次 --json 必须报出磁盘字节数，不得 "could not be measured"');
      assert.ok(report.machine.freeDiskBytes > 0);
      // 磁盘事实已可测 → 推荐理由里不得出现「无法测量」借口（verdict 本身取决于
      // 测试机内存，不锁死；只锁磁盘未知的退化路径）
      assert.equal(
        report.l3.recommend.reasons.some((r) => r.includes('could not be measured')),
        false,
        '磁盘可测时不得用 "could not be measured" 作理由',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('显式 installDir 指向不存在的目录：同样退让，磁盘事实仍为数字', () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-r1b-'));
    try {
      const ghost = path.join(root, 'ghost', 'install', 'dir');
      const report = detect({ homedir: root, installDir: ghost, env: {} });
      assert.equal(typeof report.machine.freeDiskBytes, 'number', '显式 installDir 幽灵路径不得让磁盘事实退化为 null');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('R2 posix 端：注入 platform=win32 必须走 win32 分支——powershell 缺位 → 诚实 null，不得产出 statfs 假读数', () => {
    if (process.platform === 'win32') return; // 本锁验证 posix 上的分支生效性
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-r2p-'));
    try {
      const report = detect({ homedir: root, env: {}, platform: 'win32' });
      assert.equal(report.machine.platform, 'win32', 'platform 注入必须生效');
      // posix 上 powershell 不存在：若实现忘了切分支而走了 statfs → 会给数字 → 必须红。
      // null 恰好证明 win32 分支真的执行了（R2 杀手锁：Windows 不该恒 skip）。
      assert.equal(
        report.machine.freeDiskBytes,
        null,
        'posix 注入 win32 不得产出 statfs 假读数——win32 探测分支必须生效，且不伪造数字',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('R2 Windows 真机端：Get-PSDrive 必须报出数字（不伪造、不抛），null 降级必须带保守 skip 理由', () => {
    if (process.platform !== 'win32') return; // CI windows runner 上跑真 powershell
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-r2w-'));
    try {
      const report = detect({ homedir: root, env: {}, platform: 'win32' });
      const v = report.machine.freeDiskBytes;
      assert.equal(typeof v, 'number', 'Windows 真机必须报出磁盘字节数（Get-PSDrive 探测不可缺席）');
      assert.ok(v >= 0, '磁盘字节数不得为负');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('R2 降级口径：null 时 recommend 必须带 "could not be measured" 理由（诚实 skip，不许伪造数字）', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-r2d-'));
    try {
      // 直接构造不可测场景（posix 注入 win32 = powershell 缺位）验证 null 的诚实语义
      const report = detect({ homedir: root, env: {}, platform: 'win32' });
      if (report.machine.freeDiskBytes === null) {
        assert.ok(
          report.l3.recommend.reasons.some((r) => r.includes('could not be measured')),
          '磁盘不可测时 recommend 必须说明理由，不得静默 skip',
        );
        assert.equal(report.l3.recommend.verdict, 'skip', '磁盘不可测 → 保守 skip（绝不误导为 install）');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════
// [LOCK-53-17] doWriteConfig 端到端：落盘 + 0600 + 备份 + app 可接受
//
// 为什么这把锁必须存在（AC1）：
//   写出的 subagent 块必须能被 app 的 validateSettings 接受（从 dist 真导入验证），
//   provider 字段绝迹——N11：带 provider 的块被 app 整段静默忽略，subagent 永不工作。
// ═══════════════════════════════════════════════

describe('[LOCK-53-17] doWriteConfig 端到端', () => {
  const GB = 1024 ** 3;

  function writeReport(cfgPath) {
    return { config: { path: cfgPath, exists: true } };
  }

  test('三必填真实落盘：恰含 model/baseUrl/apiKey，app validateSettings 零错误（AC1/N11 杀手锁）', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adr53-e2e-'));
    try {
      const cfgPath = path.join(dir, 'config.json');
      writeFileSync(cfgPath, JSON.stringify(validBaseConfig()), 'utf8');
      captureStdout(() => {
        doWriteConfig(writeReport(cfgPath), {
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-3-5-sonnet-20241022',
          key: 'sk-e2e',
          dryRun: false,
        });
      });
      const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
      assert.deepEqual(written.subagent, {
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: 'sk-e2e',
      });
      // 真 app 校验：写出的 config 必须被 validateSettings 接受
      assert.deepEqual(validateSettings(structuredClone(written)), [], 'app 应接受写出的 config');
      // 备份存在
      assert.ok(existsSync(`${cfgPath}.myterminal-backup`), '写前必须备份');
      // 0600（Windows 上 mode 语义不可靠，跳过）——备份含 connectorKey/actionsToken，
      // 必须与主文件同权，copyFileSync 继承 umask 的 0644 是泄露（R4 杀手锁）
      if (process.platform !== 'win32') {
        assert.equal(fs_statMode(cfgPath), 0o600, 'config.json 必须 0600');
        assert.equal(fs_statMode(`${cfgPath}.myterminal-backup`), 0o600, '备份必须与主文件同权 0600');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('遗留 provider 在写盘前被拔除：validateSettings 接受且不会整段忽略（N2/N11 杀手锁）', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adr53-legacy-'));
    try {
      const cfgPath = path.join(dir, 'config.json');
      writeFileSync(
        cfgPath,
        JSON.stringify(validBaseConfig({
          subagent: { provider: 'openai', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-old' },
        })),
        'utf8',
      );
      captureStdout(() => {
        doWriteConfig(writeReport(cfgPath), {
          baseUrl: 'https://api.anthropic.com',
          model: 'claude-3-5-sonnet-20241022',
          dryRun: false, // 不给新 key → 保留已有
        });
      });
      const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
      assert.equal('provider' in written.subagent, false, 'provider 必须绝迹');
      assert.equal(written.subagent.apiKey, 'sk-old', '未给新 key 时应保留已有 key');
      assert.deepEqual(validateSettings(structuredClone(written)), [], 'app 应接受写出的 config');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('可选字段提示出现在输出里（代理要转述给用户，D2）', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adr53-opt-'));
    try {
      const cfgPath = path.join(dir, 'config.json');
      writeFileSync(cfgPath, JSON.stringify(validBaseConfig()), 'utf8');
      const out = captureStdout(() => {
        doWriteConfig(writeReport(cfgPath), {
          baseUrl: 'https://x', model: 'm', key: 'k', dryRun: false,
        });
      });
      assert.match(out, /maxTurns/);
      assert.match(out, /compactThreshold/);
      assert.match(out, /default\s+50/);   // 对齐列是多空格分隔
      assert.match(out, /80000/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('缺 key 且 config 无已有 key → 抛错，文件不动（写不出 app 会拒的 config）', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adr53-nokey-'));
    try {
      const cfgPath = path.join(dir, 'config.json');
      const before = JSON.stringify(validBaseConfig());
      writeFileSync(cfgPath, before, 'utf8');
      assert.throws(
        () => captureStdout(() => {
          doWriteConfig(writeReport(cfgPath), { baseUrl: 'https://x', model: 'm', dryRun: false });
        }),
        /apiKey/,
      );
      assert.equal(readFileSync(cfgPath, 'utf8'), before, '失败时不得落盘');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--fallback-model 端到端落盘：文件里真实出现 subagent.fallbackModel', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adr53-fb-'));
    try {
      const cfgPath = path.join(dir, 'config.json');
      writeFileSync(cfgPath, JSON.stringify(validBaseConfig()), 'utf8');
      captureStdout(() => {
        doWriteConfig(writeReport(cfgPath), {
          baseUrl: 'https://x', model: 'm', key: 'k', fallbackModel: 'm-mini', dryRun: false,
        });
      });
      const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
      assert.equal(written.subagent.fallbackModel, 'm-mini', 'fallbackModel 必须真实落盘');
      assert.deepEqual(validateSettings(structuredClone(written)), [], 'app 应接受写出的 config');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dry-run 不写盘、不备份、输出打码', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adr53-dr-'));
    try {
      const cfgPath = path.join(dir, 'config.json');
      const before = JSON.stringify(validBaseConfig());
      writeFileSync(cfgPath, before, 'utf8');
      const out = captureStdout(() => {
        doWriteConfig(writeReport(cfgPath), {
          baseUrl: 'https://x', model: 'm', key: 'sk-dryrun-secret', dryRun: true,
        });
      });
      assert.equal(out.includes('sk-dryrun-secret'), false);
      assert.ok(out.includes('<redacted>'));
      assert.equal(readFileSync(cfgPath, 'utf8'), before);
      assert.equal(existsSync(`${cfgPath}.myterminal-backup`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fs_statMode(file) {
  // ESM 无 require；statSync 从顶部统一导入
  return (statSync(file).mode & 0o777);
}
