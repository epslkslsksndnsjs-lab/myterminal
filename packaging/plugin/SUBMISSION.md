# MyTerminal 插件上架分步清单

目标：让 ChatGPT 网页端用户在插件目录里安装 MyTerminal，直接驱动你已授权的工作区。
前置阅读：`packaging/plugin/README.md`（两种形态）、OpenAI 插件提交流程（developers.openai.com/plugins/deploy/submission）。

## 0. 前置条件

- [ ] OpenAI 开发者平台账号，组织设置里完成**个人或企业实名认证**（目录显示的身份以此为准）
- [ ] 一个稳定公网 HTTPS 端点：域名 + 证书 + 反向代理（VPS、Cloudflare、任何主机都行）
- [ ] myterminal 在该主机上以 `myterminal --headless` 常驻（TUI 里先配好工作区、host、连接凭证）

## 1. 托管 MCP 端点

- [ ] 反向代理把 `https://<你的域名>/mcp/` 转发到 myterminal 的 `/mcp/:connectorKey`
- [ ] 从 TUI Settings 复制 connectorKey（按住 V 显示），拼出完整 URL：
  `https://<你的域名>/mcp/<connectorKey>`
- [ ] 自测：`curl -i -X POST https://<你的域名>/mcp/<connectorKey> -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'` 应返回工具清单
- [ ] `/health` 可被公开访问（审核扫描用）

> 注意：connectorKey 在 URL 里 = 共享密钥。单租户形态下谁拿到 URL 谁就连同一个工作区。要更紧，可在代理层再加 Basic Auth 或按路径换 key——但门户连接不支持自定义 header，所以代理层的额外认证会挡住目录连接，仅适合自用。

## 2. 填占位符

- [ ] `packaging/plugin/mcp.json`：`REPLACE-WITH-YOUR-MCP-HOST` / `REPLACE-WITH-CONNECTOR-KEY`
- [ ] `packaging/plugin/plugin.json`：`review.demo_recording_url` 换成真实演示视频地址（2-5 分钟走查：安装 → 发现 → 读项目 → 跑命令 → 出结果；未公开上传即可）
- [ ] 按需调整 `publication.countries`（默认 US/CA/GB/AU/SG）和 `developerName`（必须与实名认证身份一致）

## 3. 域名验证

门户会给出一个 challenge token。以**纯文本**（只返回 token 本身，不是 JSON）托管在：

```text
https://<MCP 主机名或合格父域>/.well-known/openai-apps-challenge
```

myterminal 不服务这个路径，放在你的反向代理上，任选其一：

```nginx
# nginx
location = /.well-known/openai-apps-challenge {
    default_type text/plain;
    return 200 "在这里粘贴门户给的 token";
}
```

```text
# 或直接用 python 起一个静态文件服务器（仅验证期间需要）
mkdir -p .well-known && echo -n "TOKEN" > .well-known/openai-apps-challenge
python3 -m http.server 443 --bind 127.0.0.1  # 前面照常挂代理
```

## 4. 构建提交包

```bash
bun scripts/package-plugin.mjs
```

- [ ] 校验全绿（无 ERROR；占位符 WARNING 已清零）
- [ ] 产出 `packaging/myterminal-plugin.zip`，根目录含 `plugin.json` / `mcp.json` / `skills/` / `assets/`
- [ ] ZIP 里**没有**任何凭证、clientSecret、非空 headers（脚本会查）

## 5. 上传与自动检查

- [ ] 插件目录页 → Upload new plugin → 选实名身份 → 传 ZIP
- [ ] Metadata & Skills：等自动检查跑完，逐条修 findings（文案违规、URL 不可达、skill 扫描）
- [ ] MCPs → Connect：确认 MCP Server URL、认证方式（无认证）、完成域名 challenge → 连接 → 等工具扫描 → 检查发现的问题

## 6. 提交人工审核

- [ ] Review details 里填**审核用测试账号**：给审核员一个可连的 myterminal 实例地址 + connectorKey + 一个示例工作区（放在仪表板，**不要**写进 ZIP）
- [ ] `review.test_cases` 已随包导入（5 正 3 负，在仪表板只读）
- [ ] 提交。业内反馈初审约 1-2 周，按反馈迭代

## 7. 发布与后续

- [ ] 通过后自选时间点 Publish
- [ ] 发布后：MCP server 端的改动（工具、行为）自动生效；元数据/skill 改动要重新传 ZIP
- [ ] 想扩大国家范围：仪表板里改 publication

## 审核等待期就能用

同一端点不必等审核——ChatGPT 设置 → 连接器（Connectors）→ 自定义 MCP（Developer Mode）→ 填 `https://<域名>/mcp/<connectorKey>` 即可立刻在对话里用。这叫"自用通道"，与目录分发并行。

## 什么时候升级到多租户

当安装者需要连**自己的**机器而不是你的工作区时，单租户包就不够了。那时要做：OAuth 设备流配对 + `myterminal remote` 设备代理 + 云中继 + 设备注册表（RDC 架构）。本包 `mcp.json` 已按门户规范预留 OAuth 字段位（`authorizationUrl` / `tokenUrl` / DCR），届时只换认证配置，不动清单其余部分。
