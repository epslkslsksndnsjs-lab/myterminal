// ADR-0043 —— MyTerminal Onboarding 技能：onboard.mjs 纯逻辑锁
//
// 背景（ADR-0043 CP3）：
//   技能 skills/myterminal-onboarding/ 的「一条命令」是 scripts/onboard.mjs。
//   它做两类事：① 有副作用的（clone/build/写文件） ② 纯逻辑的（探测、校验、渲染、合并）。
//   本文件只锁 ②——纯函数，不 clone、不 build、不碰真实 HOME。
//
// 立锁纪律：
//   onboard.mjs 的纯逻辑必须与主仓事实逐字一致，主仓改了这里就该红。
//   四条事实源（本测试的真值来源，改主仓必须同步改这里）：
//     S1  src/types.ts:185           SUBAGENT_PROVIDERS = 5 个闭列表
//     S2  src/subagent/llm-adapter.ts:1099-1147  各 provider 的环境变量名
//     S3  src/config.ts:24-30        settingsPath 的三级回退 + optionalEnv 空串视为未设
//     S4  src/config.ts:101-108      subagent 默认值（enabled/maxTurns/timeoutSec/maxParallel）
//
// 分区：
//   [LOCK-43-1] provider 闭列表 + 环境变量名与主仓一致（ADR-0043 D6/D8 诚实边界的地基）
//   [LOCK-43-2] 配置路径解析复刻 settingsPath 三级回退
//   [LOCK-43-3] shell profile 探测（含原生 Windows 走手动、fish 语法分叉）
//   [LOCK-43-4] export 行渲染（引号包裹 + fish 分叉）
//   [LOCK-43-5] config 合并：不落 key、不吞用户已有字段、补默认值
//   [LOCK-43-6] profile 幂等追加：重复跑不产生第二份
//   [LOCK-43-7] bun 版本解析与比较（数字比较，非字典序）
//   [LOCK-43-8] config 可写性判定——绝不凭空造 config.json（否则把首次启动搞砖）
//
// 变异体清单：
//   N1  给闭列表偷加 provider（假装支持 any-model）      → LOCK-43-1 杀
//   N2  qwen 的环境变量写成 QWEN_API_KEY                  → LOCK-43-1 杀
//   N3  XDG_CONFIG_HOME="" 被当成有效值                   → LOCK-43-2 杀
//   N4  原生 Windows 也去写 ~/.bashrc                     → LOCK-43-3 杀
//   N5  把 API key 写进 config.json                       → LOCK-43-5 杀
//   N6  合并时整段覆盖，用户的 maxTurns 被吞              → LOCK-43-5 杀
//   N7  profile 追加不幂等，跑两次两份 export             → LOCK-43-6 杀
//   N8  版本比较用字符串，1.10.0 < 1.3.0                  → LOCK-43-7 杀
//   N9  config 不存在时凭空写一份只有 subagent 段的       → LOCK-43-8 杀（会砖首次启动）
//   N10 config 有但 schemaVersion≠1 仍照写                → LOCK-43-8 杀
//   N11 入口守卫用 argv[1] 直接比 import.meta.url，
//       经符号链接调用时静默不执行（命令哑火）            → LOCK-43-9 杀

import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  SUPPORTED_PROVIDERS,
  validateProvider,
  resolveConfigPath,
  detectShellProfile,
  buildExportLine,
  buildBaseUrlLine,
  BASE_URL_ENV,
  doKey,
  mergeSubagentConfig,
  appendProfileBlock,
  parseBunVersion,
  satisfiesMinVersion,
  assessConfigWritability,
  verifyProviderKey,
  VERIFY_ENDPOINTS,
  FIRST_RUN_FIELDS,
  validateModelForProvider,
  MODEL_PREFIXES,
  lookupInstallDir,
  INSTALL_CANDIDATE_DIRS,
  shouldRebuild,
  repairConfig,
  detect,
  checkHealth,
  doHealthCheck,
  REQUIRED_CONFIG_FIELDS,
  PROFILE_MARKER_BEGIN,
  PROFILE_MARKER_END,
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
    ...extra,
  };
}

// ═══════════════════════════════════════════════
// [LOCK-43-1] provider 闭列表 + 环境变量名
//   真值：src/types.ts:185 与 llm-adapter.ts createAdapter
// ═══════════════════════════════════════════════

describe('[LOCK-43-1] provider 闭列表与主仓一致', () => {
  // 逐字锁——主仓 createAdapter 是什么，这里就必须是什么
  const TRUTH = {
    openai: { envVar: 'OPENAI_API_KEY', defaultModel: 'gpt-4o' },
    anthropic: { envVar: 'ANTHROPIC_API_KEY', defaultModel: 'claude-3-5-sonnet-20241022' },
    deepseek: { envVar: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-chat' },
    glm: { envVar: 'GLM_API_KEY', defaultModel: 'glm-4' },
    qwen: { envVar: 'DASHSCOPE_API_KEY', defaultModel: 'qwen-max' },
  };

  test('恰好 5 个 provider，一个不多一个不少', () => {
    const names = SUPPORTED_PROVIDERS.map((p) => p.provider);
    assert.deepEqual(names, ['openai', 'anthropic', 'deepseek', 'glm', 'qwen']);
  });

  test('每个 provider 的环境变量名逐字正确（qwen 是 DASHSCOPE_API_KEY，不是 QWEN_API_KEY）', () => {
    for (const entry of SUPPORTED_PROVIDERS) {
      const truth = TRUTH[entry.provider];
      assert.ok(truth, `未登记的 provider: ${entry.provider}`);
      assert.equal(entry.envVar, truth.envVar, `${entry.provider} 环境变量名漂移`);
      assert.equal(entry.defaultModel, truth.defaultModel, `${entry.provider} 默认模型漂移`);
    }
  });

  test('每个 provider 都带控制台链接（AI 要指引用户去哪拿 key）', () => {
    for (const entry of SUPPORTED_PROVIDERS) {
      assert.match(entry.consoleUrl, /^https:\/\//, `${entry.provider} 缺 consoleUrl`);
    }
  });

  test('validateProvider 接受 5 个之内的', () => {
    const r = validateProvider('deepseek');
    assert.equal(r.ok, true);
    assert.equal(r.entry.envVar, 'DEEPSEEK_API_KEY');
  });

  test('validateProvider 大小写与空白不敏感', () => {
    const r = validateProvider('  OpenAI  ');
    assert.equal(r.ok, true);
    assert.equal(r.entry.provider, 'openai');
  });

  test('validateProvider 拒绝闭列表外的，并如实给出 5 个选项（ADR-0043 D8）', () => {
    const r = validateProvider('gemini');
    assert.equal(r.ok, false);
    assert.deepEqual(r.supported, ['openai', 'anthropic', 'deepseek', 'glm', 'qwen']);
    // 诚实边界：必须说明需要改代码，不能给错误希望
    assert.match(r.message, /createAdapter/);
    assert.match(r.message, /gemini/);
  });
});

// ═══════════════════════════════════════════════
// [LOCK-43-2] 配置路径解析（复刻 src/config.ts settingsPath）
// ═══════════════════════════════════════════════

describe('[LOCK-43-2] resolveConfigPath 复刻 settingsPath 三级回退', () => {
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

  test('MYTERMINAL_CONFIG_DIR 最高优先，且不再追加 myterminal 段', () => {
    assert.equal(
      resolveConfigPath({ MYTERMINAL_CONFIG_DIR: '/custom/dir', XDG_CONFIG_HOME: '/xdg' }, HOME),
      path.join('/custom/dir', 'config.json'),
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
// [LOCK-43-3] shell profile 探测（ADR-0043 D6：posix 为主，原生 Windows 手动）
// ═══════════════════════════════════════════════

describe('[LOCK-43-3] detectShellProfile', () => {
  const HOME = '/home/tester';

  test('macOS + zsh → ~/.zshrc', () => {
    const r = detectShellProfile({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, homedir: HOME });
    assert.equal(r.kind, 'zsh');
    assert.equal(r.path, path.join(HOME, '.zshrc'));
    assert.equal(r.manual, false);
  });

  test('Linux + bash → ~/.bashrc', () => {
    const r = detectShellProfile({ platform: 'linux', env: { SHELL: '/usr/bin/bash' }, homedir: HOME });
    assert.equal(r.kind, 'bash');
    assert.equal(r.path, path.join(HOME, '.bashrc'));
  });

  test('macOS + bash → ~/.bash_profile（macOS 登录 shell 惯例）', () => {
    const r = detectShellProfile({ platform: 'darwin', env: { SHELL: '/bin/bash' }, homedir: HOME });
    assert.equal(r.kind, 'bash');
    assert.equal(r.path, path.join(HOME, '.bash_profile'));
  });

  test('fish → ~/.config/fish/config.fish', () => {
    const r = detectShellProfile({ platform: 'linux', env: { SHELL: '/usr/bin/fish' }, homedir: HOME });
    assert.equal(r.kind, 'fish');
    assert.equal(r.path, path.join(HOME, '.config', 'fish', 'config.fish'));
  });

  test('SHELL 缺失：macOS 回退 zsh，Linux 回退 bash', () => {
    assert.equal(detectShellProfile({ platform: 'darwin', env: {}, homedir: HOME }).kind, 'zsh');
    assert.equal(detectShellProfile({ platform: 'linux', env: {}, homedir: HOME }).kind, 'bash');
  });

  test('WSL 仍按 posix 处理，但打上 wsl 标记', () => {
    const r = detectShellProfile({
      platform: 'linux',
      env: { SHELL: '/bin/bash', WSL_DISTRO_NAME: 'Ubuntu' },
      homedir: HOME,
    });
    assert.equal(r.manual, false);
    assert.equal(r.wsl, true);
    assert.equal(r.path, path.join(HOME, '.bashrc'));
  });

  test('原生 Windows → 不写任何 profile，标记为手动（D6）', () => {
    const r = detectShellProfile({ platform: 'win32', env: {}, homedir: 'C:\\Users\\tester' });
    assert.equal(r.kind, 'windows-native');
    assert.equal(r.manual, true);
    assert.equal(r.path, null);
    // 必须给出可照抄的手动指令
    assert.match(r.manualHint, /setx/i);
  });
});

// ═══════════════════════════════════════════════
// [LOCK-43-4] export 行渲染
// ═══════════════════════════════════════════════

describe('[LOCK-43-4] buildExportLine', () => {
  test('posix：export NAME="value"，值加引号防特殊字符', () => {
    assert.equal(buildExportLine('openai', 'sk-abc123', 'zsh'), 'export OPENAI_API_KEY="sk-abc123"');
    assert.equal(buildExportLine('qwen', 'sk-xyz', 'bash'), 'export DASHSCOPE_API_KEY="sk-xyz"');
  });

  test('fish 用 set -gx，不是 export', () => {
    assert.equal(buildExportLine('glm', 'k1', 'fish'), 'set -gx GLM_API_KEY "k1"');
  });

  test('值里的双引号被转义，不破坏行', () => {
    const line = buildExportLine('openai', 'a"b', 'zsh');
    assert.equal(line, 'export OPENAI_API_KEY="a\\"b"');
  });

  test('闭列表外的 provider 直接抛错，不静默生成垃圾行', () => {
    assert.throws(() => buildExportLine('gemini', 'k', 'zsh'), /gemini/);
  });
});

// ═══════════════════════════════════════════════
// [LOCK-43-5] config 合并（ADR-0043 D2：不含 key）
// ═══════════════════════════════════════════════

describe('[LOCK-43-5] mergeSubagentConfig', () => {
  test('空配置 → 补齐主仓默认值（对齐 src/config.ts:101-108）', () => {
    const out = mergeSubagentConfig({}, { provider: 'openai', model: 'gpt-4o' });
    assert.deepEqual(out.subagent, {
      enabled: true,
      provider: 'openai',
      model: 'gpt-4o',
      maxTurns: 50,
      timeoutSec: 300,
      maxParallel: 2,
    });
  });

  test('绝不把 API key 写进 config（D2 铁律）', () => {
    const out = mergeSubagentConfig(
      { subagent: { apiKey: 'sk-leak', api_key: 'sk-leak2', key: 'sk-leak3' } },
      { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-should-be-ignored' },
    );
    const serialized = JSON.stringify(out);
    assert.equal(serialized.includes('sk-leak'), false);
    assert.equal(serialized.includes('sk-should-be-ignored'), false);
    assert.equal('apiKey' in out.subagent, false);
    assert.equal('api_key' in out.subagent, false);
    assert.equal('key' in out.subagent, false);
  });

  test('用户已有的 subagent 字段不被吞（只改 provider/model）', () => {
    const existing = {
      subagent: { enabled: false, provider: 'glm', model: 'glm-4', maxTurns: 12, timeoutSec: 60, maxParallel: 5, fallbackModel: 'glm-4-flash' },
    };
    const out = mergeSubagentConfig(existing, { provider: 'deepseek', model: 'deepseek-chat' });
    assert.equal(out.subagent.provider, 'deepseek');
    assert.equal(out.subagent.model, 'deepseek-chat');
    assert.equal(out.subagent.maxTurns, 12);
    assert.equal(out.subagent.timeoutSec, 60);
    assert.equal(out.subagent.maxParallel, 5);
    assert.equal(out.subagent.fallbackModel, 'glm-4-flash');
    assert.equal(out.subagent.enabled, false, 'enabled 是用户显式选择，不许被默认值改写');
  });

  test('config 里 subagent 之外的段落原样保留', () => {
    const existing = { schemaVersion: 1, workspaces: [{ name: 'w1' }], theme: 'dark' };
    const out = mergeSubagentConfig(existing, { provider: 'openai', model: 'gpt-4o' });
    assert.equal(out.schemaVersion, 1);
    assert.deepEqual(out.workspaces, [{ name: 'w1' }]);
    assert.equal(out.theme, 'dark');
  });

  test('纯函数：不改原对象', () => {
    const existing = { subagent: { provider: 'glm', model: 'glm-4' } };
    const snapshot = JSON.stringify(existing);
    mergeSubagentConfig(existing, { provider: 'openai', model: 'gpt-4o' });
    assert.equal(JSON.stringify(existing), snapshot);
  });

  test('闭列表外的 provider 拒绝合并', () => {
    assert.throws(() => mergeSubagentConfig({}, { provider: 'gemini', model: 'x' }), /gemini/);
  });
});

// ═══════════════════════════════════════════════
// [LOCK-43-6] profile 幂等追加（ADR-0043 D2）
// ═══════════════════════════════════════════════

describe('[LOCK-43-6] appendProfileBlock 幂等', () => {
  const LINE = 'export OPENAI_API_KEY="sk-1"';

  test('首次追加：带 begin/end 标记', () => {
    const r = appendProfileBlock('# my rc\n', [LINE]);
    assert.equal(r.changed, true);
    assert.ok(r.content.includes(PROFILE_MARKER_BEGIN));
    assert.ok(r.content.includes(PROFILE_MARKER_END));
    assert.ok(r.content.includes(LINE));
    assert.ok(r.content.startsWith('# my rc\n'), '原有内容必须保留在前');
  });

  test('重复跑同样内容：不变、changed=false（N7 杀手锁）', () => {
    const first = appendProfileBlock('# my rc\n', [LINE]);
    const second = appendProfileBlock(first.content, [LINE]);
    assert.equal(second.changed, false);
    assert.equal(second.content, first.content);
    // 只能有一份标记
    assert.equal(second.content.split(PROFILE_MARKER_BEGIN).length - 1, 1);
  });

  test('换 key 重跑：就地替换块内容，不产生第二份块', () => {
    const first = appendProfileBlock('# my rc\n', [LINE]);
    const second = appendProfileBlock(first.content, ['export OPENAI_API_KEY="sk-2"']);
    assert.equal(second.changed, true);
    assert.equal(second.content.split(PROFILE_MARKER_BEGIN).length - 1, 1);
    assert.equal(second.content.includes('sk-1'), false, '旧 key 必须被替换掉');
    assert.ok(second.content.includes('sk-2'));
  });

  test('块后面的用户内容不被吃掉', () => {
    const first = appendProfileBlock('# head\n', [LINE]);
    const withTail = `${first.content}\n# tail line\n`;
    const second = appendProfileBlock(withTail, ['export OPENAI_API_KEY="sk-2"']);
    assert.ok(second.content.includes('# head'));
    assert.ok(second.content.includes('# tail line'));
  });

  test('空 profile（新文件）也能安全追加', () => {
    const r = appendProfileBlock('', [LINE]);
    assert.equal(r.changed, true);
    assert.ok(r.content.includes(LINE));
  });

  test('原文件无结尾换行时，追加前自动补换行（不粘连上一行）', () => {
    const r = appendProfileBlock('# no trailing newline', [LINE]);
    assert.equal(r.content.includes('# no trailing newline' + PROFILE_MARKER_BEGIN), false);
    assert.ok(r.content.includes('# no trailing newline\n'));
  });
});

// ═══════════════════════════════════════════════
// [LOCK-43-7] bun 版本（package.json engines: bun>=1.3.0）
// ═══════════════════════════════════════════════

describe('[LOCK-43-7] bun 版本解析与比较', () => {
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

  test('satisfiesMinVersion 用数字比较，不是字典序（N8 杀手锁）', () => {
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
// [LOCK-43-8] config 可写性判定
//
// 为什么这把锁必须存在（主仓事实）：
//   src/config.ts:200  parseMyTerminalSettings —— schemaVersion !== 1 直接 throw
//   src/config.ts:113  validateSettings       —— workspaceDir/host/port/publicBaseUrl/
//                                                connectorKey(>=24)/actionsToken(>=24)/
//                                                maxOutputChars/commandTimeoutSec 全部必填
//   src/cli.ts:48-54   ensureSettings         —— 注释写死「配置无效时绝不回退到首次运行默认值，
//                                                因为那会悄悄替换稳定凭据」→ 直接抛错
//
// 推论：onboard 若在 config.json 不存在时凭空写一份只有 subagent 段的文件，
//       用户首次启动会 throw，而且再也走不进 setup TUI —— 等于把安装搞砖。
//       连接器凭据是随机 32 字节，脚本没资格伪造。
//       正确做法：让用户先跑一次 MyTerminal 完成 setup TUI，再回来写 subagent。
// ═══════════════════════════════════════════════

describe('[LOCK-43-8] assessConfigWritability 绝不凭空造 config', () => {
  test('config 不存在 → 拒写，并指引先跑一次 setup（N9 杀手锁）', () => {
    const r = assessConfigWritability(null);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing');
    // 必须给出可执行的下一步，而不是干巴巴报错
    assert.match(r.guidance, /bun run dev/);
    // 必须解释为什么脚本不能自己造
    assert.match(r.guidance, /credential/i);
  });

  test('config 是坏 JSON → 拒写，不覆盖用户文件', () => {
    const r = assessConfigWritability({ __parseError: 'Unexpected token }' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unparsable');
  });

  test('schemaVersion 不是 1 → 拒写（主仓会 throw）（N10 杀手锁）', () => {
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

  test('放行后合并，主仓必填字段一个不少地活下来', () => {
    const base = validBaseConfig({ subagent: { enabled: true, provider: 'glm', model: 'glm-4', maxTurns: 7, timeoutSec: 30, maxParallel: 1 } });
    const out = mergeSubagentConfig(base, { provider: 'openai', model: 'gpt-4o' });
    for (const field of ['schemaVersion', 'workspaceDir', 'host', 'port', 'publicBaseUrl', 'connectorKey', 'actionsToken', 'maxOutputChars', 'commandTimeoutSec']) {
      assert.deepEqual(out[field], base[field], `必填字段 ${field} 在合并中丢失/被改`);
    }
    assert.equal(out.subagent.provider, 'openai');
    assert.equal(out.subagent.maxTurns, 7);
  });
});

// ═══════════════════════════════════════════════
// [LOCK-43-9] 入口守卫必须穿透符号链接
//
// 为什么这把锁必须存在（ADR-0043）：
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

describe('[LOCK-43-9] 经符号链接调用仍会执行', () => {
  test('node 必须可用——脚本与 shebang 都依赖它', () => {
    assert.ok(
      RUNTIMES.some((r) => r.name === 'node'),
      'node 不在 PATH 上，N11 这条锁形同虚设（本机应装 node）',
    );
  });

  for (const runtime of RUNTIMES) {
    test(`[${runtime.name}] 直接路径调用有输出（基线）`, () => {
      const out = execFileSync(runtime.bin, [SCRIPT_PATH, '--help'], { encoding: 'utf8' });
      assert.match(out, /USAGE/);
    });

    test(`[${runtime.name}] 经符号链接调用同样有输出（N11 杀手锁）`, () => {
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

    test(`[${runtime.name}] 被 import 时绝不自动执行（修 N11 不能变成一 import 就跑）`, () => {
      const probe = `import('${SCRIPT_PATH}').then(() => process.stdout.write('IMPORTED_QUIET'));`;
      const out = execFileSync(runtime.bin, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
      assert.equal(out.trim(), 'IMPORTED_QUIET', 'import 时不该有任何额外输出');
    });
  }
});

// ═══════════════════════════════════════════════
// [LOCK-43-10] provider key 真实验证（P0-1）
//
// 为什么这把锁必须存在（ADR-0043 D11，用户评审 P0）：
//   旧流程结束只 echo $ENV_VAR 看 key 在不在，从不验证 key 有效、也从不
//   通一次 provider。拿个吊销的 key 走完全程，只有 runtime 调 subagent 崩了
//   才发现。verifyProviderKey 必须：① 为每个 provider 构造正确的请求
//   （URL/header/body）② 200→ok ③ 非200→fail 带 HTTP 状态 ④ 网络错→graceful。
//   网络调用通过注入 fetchImpl 锁，不真打外网。
// ═══════════════════════════════════════════════

describe('[LOCK-43-10] provider key 真实验证（P0-1）', () => {
  function fakeFetch(expectStatus = 200, bodyText = '{}') {
    const calls = [];
    const impl = async (url, opts) => {
      calls.push({ url, opts });
      return {
        ok: expectStatus >= 200 && expectStatus < 300,
        status: expectStatus,
        text: async () => bodyText,
      };
    };
    return { calls, impl };
  }

  test('VERIFY_ENDPOINTS 五种 provider 的 base URL 与仓库 llm-adapter.ts 一致', () => {
    assert.equal(VERIFY_ENDPOINTS.openai.baseUrl, 'https://api.openai.com/v1');
    assert.equal(VERIFY_ENDPOINTS.anthropic.baseUrl, 'https://api.anthropic.com/v1');
    assert.equal(VERIFY_ENDPOINTS.deepseek.baseUrl, 'https://api.deepseek.com/v1');
    assert.equal(VERIFY_ENDPOINTS.glm.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
    assert.equal(VERIFY_ENDPOINTS.qwen.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  });

  test('openai 系构造 /chat/completions + Bearer + max_tokens=1', async () => {
    const { calls, impl } = fakeFetch(200);
    const r = await verifyProviderKey('openai', 'sk-test', { fetchImpl: impl });
    assert.ok(r.ok, '200 应判定 ok');
    assert.equal(r.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/chat\/completions$/);
    assert.equal(calls[0].opts.headers.authorization, 'Bearer sk-test');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.model, 'gpt-4o');
    assert.equal(body.max_tokens, 1);
  });

  test('anthropic 构造 /messages + x-api-key header', async () => {
    const { calls, impl } = fakeFetch(200);
    await verifyProviderKey('anthropic', 'sk-ant', { fetchImpl: impl });
    assert.match(calls[0].url, /\/messages$/);
    assert.equal(calls[0].opts.headers['x-api-key'], 'sk-ant');
    assert.equal(calls[0].opts.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.max_tokens, 1);
  });

  test('非 200 → ok=false 且带 HTTP 状态（吊销 key 必被抓住）', async () => {
    const { impl } = fakeFetch(401, '{"error":"invalid_key"}');
    const r = await verifyProviderKey('deepseek', 'bad', { fetchImpl: impl });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
    assert.match(r.message, /HTTP 401/);
  });

  test('网络异常 → ok=false status=0 不抛', async () => {
    const impl = async () => { throw new Error('ECONNREFUSED'); };
    const r = await verifyProviderKey('glm', 'k', { fetchImpl: impl });
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
    assert.match(r.message, /Network error/);
  });

  test('无 key → ok=false（不偷偷用空串打请求）', async () => {
    const impl = async () => assert.fail('不应发起请求');
    const r = await verifyProviderKey('qwen', '', { fetchImpl: impl });
    assert.equal(r.ok, false);
    assert.equal(r.status, 0);
  });

  test('闭列表外 provider → ok=false（诚实边界不变）', async () => {
    const impl = async () => assert.fail('不应发起请求');
    const r = await verifyProviderKey('gemini', 'k', { fetchImpl: impl });
    assert.equal(r.ok, false);
    assert.match(r.message, /not supported/);
  });

  test('qwen 接受 baseUrl 覆盖（DASHSCOPE_BASE_URL 场景）', async () => {
    const { calls, impl } = fakeFetch(200);
    await verifyProviderKey('qwen', 'k', { baseUrl: 'https://private/v1', fetchImpl: impl });
    assert.match(calls[0].url, /^https:\/\/private\/v1\/chat\/completions$/);
  });
});

// ═══════════════════════════════════════════════
// [LOCK-43-11] 首次运行设置界面引导（P0-2）
//
// 为什么这把锁必须存在（用户评审 P0）：
//   旧 FIRST_RUN_GUIDANCE 只说"run bun run dev"，首次使用者面对空屏不知填啥。
//   这 8 个字段就是 validateSettings 的必填清单，必须显式列出来且和
//   REQUIRED_CONFIG_FIELDS 逐字一致——少一个、错一个名字，引导就骗人。
// ═══════════════════════════════════════════════

describe('[LOCK-43-11] 首次运行设置界面引导（P0-2）', () => {
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
// [LOCK-43-12] model↔provider 一致性强制（P1-3）
//
// 为什么这把锁必须存在（用户评审 P1）：
//   SKILL.md 说"model 明显属于别的 provider 会 warn"，但 doWriteConfig 里没有任何
//   代码检查——agent 一忘就把 qwen3.7-plus 写进 provider: openai，config 写成功了，
//   runtime 调 subagent 才崩。现在 mergeSubagentConfig 直接抛错，静默写错不再发生。
// ═══════════════════════════════════════════════

describe('[LOCK-43-12] model↔provider 一致性强制（P1-3）', () => {
  test('匹配的 model → ok', () => {
    assert.equal(validateModelForProvider('openai', 'gpt-4o').ok, true);
    assert.equal(validateModelForProvider('anthropic', 'claude-3-5-sonnet-20241022').ok, true);
    assert.equal(validateModelForProvider('deepseek', 'deepseek-chat').ok, true);
    assert.equal(validateModelForProvider('glm', 'glm-4').ok, true);
    assert.equal(validateModelForProvider('qwen', 'qwen-max').ok, true);
  });

  test('空 model → ok（用 provider 默认）', () => {
    assert.equal(validateModelForProvider('openai', '').ok, true);
    assert.equal(validateModelForProvider('openai', undefined).ok, true);
  });

  test('明显错配 → ok=false，点名该用哪个 provider（杜绝 qwen3.7-plus 写进 openai）', () => {
    const r = validateModelForProvider('openai', 'qwen3.7-plus');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'mismatch');
    assert.match(r.message, /qwen/);
    assert.match(r.message, /openai/);
  });

  test('未知前缀 → ok=true 但带 advisory warning（不误杀自定义模型）', () => {
    const r = validateModelForProvider('openai', 'my-fine-tuned-42');
    assert.equal(r.ok, true);
    assert.ok(r.warning, '未知前缀应给出警告而非静默通过');
  });

  test('mergeSubagentConfig 遇错配直接抛错（不再静默写坏 config）', () => {
    const base = { schemaVersion: 1, workspaceDir: '/w', host: '127.0.0.1', port: 1, publicBaseUrl: 'x', connectorKey: 'a'.repeat(24), actionsToken: 'b'.repeat(24), maxOutputChars: 1, commandTimeoutSec: 1 };
    assert.throws(
      () => mergeSubagentConfig(base, { provider: 'openai', model: 'qwen3.7-plus' }),
      /mismatch/i,
    );
  });

  test('mergeSubagentConfig 正常 model 不抛，且 model 字段正确写入', () => {
    const base = { schemaVersion: 1, workspaceDir: '/w', host: '127.0.0.1', port: 1, publicBaseUrl: 'x', connectorKey: 'a'.repeat(24), actionsToken: 'b'.repeat(24), maxOutputChars: 1, commandTimeoutSec: 1 };
    const merged = mergeSubagentConfig(base, { provider: 'openai', model: 'gpt-4o' });
    assert.equal(merged.subagent.provider, 'openai');
    assert.equal(merged.subagent.model, 'gpt-4o');
  });

  test('MODEL_PREFIXES 覆盖全部 5 个 provider', () => {
    for (const p of SUPPORTED_PROVIDERS) {
      assert.ok(Array.isArray(MODEL_PREFIXES[p.provider]) && MODEL_PREFIXES[p.provider].length > 0, `${p.provider} 缺前缀定义`);
    }
  });
});

// ═══════════════════════════════════════════════
// [LOCK-43-13] 安装目录扫描扩展（P1-4）
//
// 为什么这把锁必须存在（用户评审 P1）：
//   原 detect 只扫 3 条固定路径；装到 ~/projects/myterminal 这类地方 → installed 误判 false
//   → doInstall 往 ~/myterminal 重新 clone，跟现有 checkout 脱节。现在扫一组标准候选目录，
//   且 suggestedInstallDir 优先用找到的真实目录。
// ═══════════════════════════════════════════════

describe('[LOCK-43-13] 安装目录扫描扩展（P1-4）', () => {
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

  test('在 ~/projects/myterminal 找到 checkout，不误判未安装（修 P1-4）', () => {
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
// [LOCK-43-14] 构建完整性检查 + --force（P2-5）
//
// 为什么这把锁必须存在（用户评审 P2）：
//   原 doInstall 只看 dist/cli.js 是否存在就跳过 build；若上次构建半成品损坏
//   （cli.js 在但 node_modules 废了，或产物比源码旧），它不重建，app 后面崩得莫名其妙。
//   shouldRebuild 必须：force→重建、cli 缺失→重建、node_modules 缺失→重建、产物过期→重建。
// ═══════════════════════════════════════════════

describe('[LOCK-43-14] 构建完整性检查 + --force（P2-5）', () => {
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
// [LOCK-43-15] 损坏 config 的 --repair 重置路径（P2-6）
//
// 为什么这把锁必须存在（用户评审 P2）：
//   原 assessConfigWritability 遇 __parseError 只说"fix or move the file"，无 --repair；
//   connectorKey/actionsToken 丢了只能手动删文件重跑设置。现在提供明确的重置路径：
//   备份破损文件并移除，让首跑界面重新 mint。健康 config 绝不碰。
// ═══════════════════════════════════════════════

describe('[LOCK-43-15] 损坏 config 的 --repair 重置路径（P2-6）', () => {
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

  test('坏 JSON → 备份并移除原文件（修 P2-6）', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mt-repair-'));
    try {
      const file = writeConfig(root, 'config.json', '{ this is not json');
      const r = repairConfig(file, {});
      assert.equal(r.ok, true);
      assert.ok(/repair-backup-/.test(r.backup), '应生成带时间戳的备份');
      assert.ok(existsSync(r.backup), '备份应存在');
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
// [LOCK-43-16] qwen/glm 可选 base URL（P2-7）
//
// 为什么这把锁必须存在（用户评审 P2）：
//   qwen 的 DASHSCOPE_BASE_URL、glm 的 OPENAI_BASE_URL 在 provider note 里写了，但 doKey
//   只写 API key 那一个 env var，自定义端点设不了。现在 buildBaseUrlLine 多输出一行。
// ═══════════════════════════════════════════════

describe('[LOCK-43-16] qwen/glm 可选 base URL（P2-7）', () => {
  test('BASE_URL_ENV 只为 qwen/glm 定义', () => {
    assert.equal(BASE_URL_ENV.qwen, 'DASHSCOPE_BASE_URL');
    assert.equal(BASE_URL_ENV.glm, 'OPENAI_BASE_URL');
    assert.equal(BASE_URL_ENV.openai, undefined);
  });

  test('qwen + base-url → 输出 DASHSCOPE_BASE_URL 行', () => {
    const line = buildBaseUrlLine('qwen', 'https://my-endpoint/v1', 'bash');
    assert.equal(line, 'export DASHSCOPE_BASE_URL="https://my-endpoint/v1"');
  });

  test('glm + base-url → 输出 OPENAI_BASE_URL 行', () => {
    const line = buildBaseUrlLine('glm', 'https://open.bigmodel.cn/api/paas/v4', 'bash');
    assert.equal(line, 'export OPENAI_BASE_URL="https://open.bigmodel.cn/api/paas/v4"');
  });

  test('fish shell → base URL 行也用 set -gx', () => {
    const line = buildBaseUrlLine('qwen', 'https://x/v1', 'fish');
    assert.equal(line, 'set -gx DASHSCOPE_BASE_URL "https://x/v1"');
  });

  test('openai 传 base-url → 忽略（返回 null，不伪造未支持的环境变量）', () => {
    assert.equal(buildBaseUrlLine('openai', 'https://x', 'bash'), null);
  });

  test('不传 base-url → 返回 null（默认行为不变）', () => {
    assert.equal(buildBaseUrlLine('qwen', '', 'bash'), null);
    assert.equal(buildBaseUrlLine('qwen', undefined, 'bash'), null);
  });

  test('doKey 非写 profile 路径同时打印 key 行与 base URL 行（qwen）', () => {
    const report = {
      shell: { kind: 'zsh', profilePath: '/tmp/profile', manual: false, manualHint: null },
      config: { subagent: null },
    };
    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (s) => { chunks.push(s); return true; };
    try {
      doKey(report, { provider: 'qwen', key: 'sk-test', baseUrl: 'https://my/v1', writeProfile: false, dryRun: false });
    } finally {
      process.stdout.write = orig;
    }
    const out = chunks.join('');
    assert.match(out, /DASHSCOPE_API_KEY/);
    assert.match(out, /DASHSCOPE_BASE_URL/);
  });
});

// ═══════════════════════════════════════════════
// [LOCK-43-17] 健康检查 --healthcheck（P2-8）
//   真值：src/server.ts:549 健康端点返回 200 + {product:'myterminal'}；
//        src/config.ts:170 握手同样认 product==='myterminal'；默认 host=127.0.0.1 port=3210。
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

describe('[LOCK-43-17] 健康检查 --healthcheck（P2-8）', () => {
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
