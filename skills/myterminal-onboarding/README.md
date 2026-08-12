# myterminal-onboarding

一个**自包含的安装 / 验证工具**（agent 技能）：把 MyTerminal 装到机器上，并一步步配置它的 subagent 大模型——provider、model、API key。

它本身是一套**测试 / 验证工具**，独立于 MyTerminal 系统代码（`src/` 等），可以单独删除而不影响 MyTerminal 本体。删除整个技能目录不会逼你改动 `src/` 任何文件。

## 用法

**1. 安装技能**（就是个文件夹，拷进 agent 的 skills 目录即可，或用一条命令安装器）：

```bash
node skills/myterminal-onboarding/scripts/install.mjs
# 或手动：
cp -R skills/myterminal-onboarding ~/.workbuddy/skills/myterminal-onboarding
```

**2. 跑 onboarding，或直接自检这份技能副本是否完整：**

```bash
node scripts/onboard.mjs --json          # 只读检测报告，什么都不写
node scripts/onboard.mjs --self-test     # 自检：确认这份技能副本的所有导出/flag 都在
```

其它用法（写配置 / 装 key / 健康检查 / 修损坏 config 等）见 `SKILL.md`。

## 它能自动做的 vs 你要做的

| 步骤 | 谁做 |
| --- | --- |
| 检测 OS / shell / bun / 已有安装 / 已有配置 | 脚本 |
| 安装 bun | **你**（一行命令，脚本会打印给你） |
| clone + `bun install` + `bun run build` | 脚本（`--install`） |
| 首次运行设置屏 | **你**（交互式，且它生成 connector 凭证） |
| 把 subagent provider/model 写入 `config.json` | 脚本（`--write-config`） |
| 从 provider 控制台取 API key | **你** |
| 把 key 写进 shell profile | 脚本（`--key - --write-profile`） |
| 重启终端 | **你** |

## 诚实的边界

- **只支持 5 个 provider**：`openai` / `anthropic` / `deepseek` / `glm` / `qwen`（`createAdapter` 硬编码的闭列表，非 any-model）。
- **bun >= 1.3.0 是硬前置**，无 npm 兜底。
- **脚本绝不伪造 `config.json`**：基础 config 含随机生成的 connector 凭证，写残缺文件会让 MyTerminal 启动即崩，所以脚本拒绝并让你先跑一次 `bun run dev`。
- **API key 永不进 `config.json`**，只用环境变量。类 key 字段在 merge 时被剥离。
- **原生 Windows 走手动步骤**（脚本打印 `setx`，WSL 更顺）。

## 安全

- 不加任何 flag = 只读。`--dry-run` 在任何写命令上只显示结果不落盘。
- config / profile 写入前先备份为 `<file>.myterminal-backup`。
- profile 编辑在标记块内、幂等——同 key 重跑是 no-op，新 key 原地替换不堆叠。
- `config.json` 保持 `0600` 权限。
- 优先 `--key -`（stdin）而非 `--key <value>`，避免 key 进 shell 历史。

## 结构

```
myterminal-onboarding/
  SKILL.md                                  agent 面向的说明
  scripts/onboard.mjs                       生产脚本（跑安装/配置逻辑，不含测试代码）
  scripts/self-test.mjs                     ⚠ 唯一的测试代码：--self-test 自检，独立文件
  scripts/install.mjs                       一条命令安装器
  templates/subagent-config.template.json   subagent 块形状（片段，非完整 config）
```

> 技能不依赖任何 `src/` 代码（`onboard.mjs` 与 `self-test.mjs` 均不读主仓源码）。原比对 provider 列表的 CI 护栏 `check-provider-sync.mjs` 已随 ADR-0045 删除 provider 概念而移除。
