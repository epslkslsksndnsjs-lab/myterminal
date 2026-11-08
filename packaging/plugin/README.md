# MyTerminal ChatGPT 插件包（第三通道）

这是 myterminal 的**第三条通道：ChatGPT 插件目录（Agent Plugins / 远程 MCP）**。前两条通道保持原样：

| 通道 | 端点 | 状态 |
|---|---|---|
| ① GPT Actions | `/openapi.json`（Bearer token） | 不动 |
| ② ChatGPT Apps / MCP | `/mcp/<connectorKey>` | 不动 |
| ③ 插件目录（本包） | 同一个 `/mcp/<connectorKey>`，经目录分发 | 新增 |

关键点：**第三通道不是新服务器，是把第二通道的 MCP 端点包装成可上架的插件包。** myterminal 的 MCP 用的是 `StreamableHTTPServerTransport`，正是目录要求的传输；提交包只描述"去哪里连"，不复制任何代码。

## 包结构

```text
packaging/plugin/
├── plugin.json                  # 目录清单（展示元数据 + 审核用例 + 发布设置）
├── mcp.json                     # MCP 服务器声明（streamable-http，指向你的公网端点）
├── skills/get-started/SKILL.md  # 上手技能：插件加载后教模型正确的会话协议
├── assets/                      # 图标（48×48 正方形 SVG，明暗两套）
├── README.md                    # 本文件
└── SUBMISSION.md                # 从零到上架的分步清单
```

## 两种使用形态（重要，先想清楚再提交）

**形态 A · 单租户（本包默认，今天就能跑）**
MCP 地址 = 你自己机器/服务器上跑的公网 myterminal，URL 里的 connectorKey 就是共享密钥。安装插件的所有人都连到**同一个**工作区。适合：自用、团队内部、演示。不需要任何新代码。

**形态 B · 多租户（每人连自己的机器）**
每个用户安装后要连自己的电脑，需要 OAuth 身份 + 设备代理 + 云中继（RDC 的架构：`myterminal remote` 子命令 + 公网中继 + 设备注册表）。这是独立的一次建设，见 `docs/` 下的 ADR 流程；本包在 `mcp.json` 里预留了 OAuth 配置位。

`mcp.json` 门户只支持三种认证：无认证 / OAuth / 混合。当前 connectorKey 在 URL 里 = 门户视角的"无认证"，密钥即地址。

## 构建

```bash
bun scripts/package-plugin.mjs
```

脚本会按 OpenAI 的字段规范校验整个包（名称、长度、URL、图标存在性、5 正 3 负审核用例、mcp.json 禁项等），通过后在 `packaging/myterminal-plugin.zip` 打出提交用的 ZIP。占位符（`REPLACE-WITH-...`）只警告不阻断，但**提交前必须全部替换**。

## 提交流程

见 [SUBMISSION.md](SUBMISSION.md)。一句话版：公网托管 myterminal → 填占位符 → 域名验证 → 构建 ZIP → 上传 → 连接 MCP → 等审核（约 1-2 周）→ 发布。审核期间同一端点可先用 ChatGPT 设置里的自定义 MCP 连接器（Developer Mode）直接连上，不必等。
