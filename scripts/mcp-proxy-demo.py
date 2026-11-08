#!/usr/bin/env python3
"""演示脚本：仅用 Python 标准库驱动 MyTerminal 的 MCP（Streamable HTTP）接口。

流程：
  1. 从 ~/.workbuddy/mcp.json 读取 myterminal 的 MCP URL（顺带读取可选请求头）；
  2. POST initialize（protocolVersion = 2025-03-26），把响应头里的 mcp-session-id
     存下来，并在后续每个请求中回带；随后发送 notifications/initialized；
  3. tools/call session_register（mode=root，name 自定义），凭证位于
     structuredContent.data.result.identity（sessionId / sessionToken）；
  4. 携带 identity 调用 subagent_start（objective 自定义，readOnly=true，
     maxTurns=5，timeoutSec=120），打印返回的 taskId；
  5. 轮询 subagent_status，直到 completed / failed / aborted 并打印状态。

注意：
  - 服务端按 mcp-session-id 维护会话，缺少该头会返回 400，所以必须先 initialize；
  - 子代理不允许再启动子代理：本脚本只能从 root 会话执行，禁止从子代理内部调用
    （即“不许嵌套启动子代理”）；
  - 只依赖标准库，不需要安装任何第三方客户端。

运行：python3 scripts/mcp-proxy-demo.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Dict, Optional, Tuple

CONFIG_PATH = os.path.expanduser("~/.workbuddy/mcp.json")
SERVER_NAME = "myterminal"
PROTOCOL_VERSION = "2025-03-26"
CLIENT_INFO = {"name": "myterminal-mcp-demo", "version": "1.0.0"}
POLL_INTERVAL_SEC = 2.0      # 轮询 subagent_status 的间隔
POLL_BUDGET_SEC = 180.0      # 轮询总预算，超时则放弃并返回非零
TERMINAL_STATES = {"completed", "failed", "aborted"}
# 兜底：配置文件结构不认识时，直接在原文里抓 /mcp/<key> 形式的 URL
URL_FALLBACK_RE = re.compile(r"https?://[^\s\"']*?/mcp/[A-Za-z0-9._-]+")


# --------------------------------------------------------------------- 读取配置


def load_myterminal_endpoint() -> Tuple[str, Dict[str, str]]:
    """从 WorkBuddy 配置里取出 myterminal 的 (url, headers)。"""
    with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
        raw = fh.read()
    config = json.loads(raw)

    # 收集所有可能形如 {名字: 条目} 的候选服务器
    candidates: Dict[str, Dict[str, Any]] = {}
    if isinstance(config, dict):
        for key in ("mcpServers", "servers", "mcp"):
            section = config.get(key)
            if isinstance(section, dict):
                for name, entry in section.items():
                    if isinstance(entry, dict):
                        candidates.setdefault(name, entry)
            elif isinstance(section, list):
                # 少数配置把服务器写成数组，用 name / id 作为键
                for entry in section:
                    if isinstance(entry, dict):
                        name = str(entry.get("name") or entry.get("id") or "")
                        if name:
                            candidates.setdefault(name, entry)
        for name, entry in config.items():
            if isinstance(entry, dict) and ("url" in entry or "serverUrl" in entry):
                candidates.setdefault(name, entry)

    # 先精确匹配 myterminal，再退化为包含匹配
    chosen: Optional[Dict[str, Any]] = None
    for name, entry in candidates.items():
        if name.lower() == SERVER_NAME:
            chosen = entry
            break
    if chosen is None:
        for name, entry in candidates.items():
            if SERVER_NAME in name.lower():
                chosen = entry
                break

    if chosen is not None:
        url = (
            chosen.get("url")
            or chosen.get("serverUrl")
            or chosen.get("httpUrl")
            or chosen.get("endpoint")
        )
        headers = chosen.get("headers") if isinstance(chosen.get("headers"), dict) else {}
        if isinstance(url, str) and url.startswith(("http://", "https://")):
            return url, {str(k): str(v) for k, v in headers.items()}

    # 最后兜底：从原始文本里找 /mcp/<connector-key> 的 URL
    match = URL_FALLBACK_RE.search(raw)
    if match:
        return match.group(0), {}
    raise RuntimeError(f'没有在 {CONFIG_PATH} 中找到 "{SERVER_NAME}" 的 MCP URL')


# --------------------------------------------------------------------- 传输层


def _parse_body(body: str, content_type: str) -> Optional[Dict[str, Any]]:
    """解析 JSON 或 SSE（text/event-stream）响应体。"""
    text = body.strip()
    if not text:
        return None
    if "text/event-stream" in content_type.lower() or text.startswith(("event:", "data:")):
        # SSE 里可能同时有进度通知和最终结果，取最后一条带 result/error 的消息
        message: Optional[Dict[str, Any]] = None
        for line in text.splitlines():
            if not line.startswith("data:"):
                continue
            chunk = line[len("data:"):].strip()
            if not chunk:
                continue
            try:
                parsed = json.loads(chunk)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict) and ("result" in parsed or "error" in parsed):
                message = parsed
        return message
    parsed = json.loads(text)
    return parsed if isinstance(parsed, dict) else None


class McpHttpClient:
    """极简 MCP Streamable HTTP 客户端：负责会话头与 JSON-RPC 编解码。"""

    def __init__(self, url: str, headers: Optional[Dict[str, str]] = None) -> None:
        self.url = url
        self.session_id: Optional[str] = None   # 来自 initialize 响应头的 mcp-session-id
        # 之后每个请求的 MCP-Protocol-Version 头，默认用我们请求的版本，协商后以服务端为准
        self.protocol_version = PROTOCOL_VERSION
        self._extra_headers = dict(headers or {})
        self._next_id = 0

    def _headers(self) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        headers.update(self._extra_headers)
        if self.session_id:
            # 关键：初始化之后每个请求都要带上同一个会话 id
            headers["mcp-session-id"] = self.session_id
            headers["MCP-Protocol-Version"] = self.protocol_version
        return headers

    def _post(self, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(self.url, data=data, headers=self._headers(), method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                session_id = resp.headers.get("mcp-session-id")
                if session_id:
                    self.session_id = session_id
                body = resp.read().decode("utf-8", "replace")
                content_type = resp.headers.get("Content-Type", "")
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")
            raise RuntimeError(
                f"请求 {payload.get('method')} 失败，HTTP {err.code}：{detail[:400]}"
            ) from None
        except urllib.error.URLError as err:
            raise RuntimeError(f"无法连接 {self.url}：{err.reason}") from None
        return _parse_body(body, content_type)

    def request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        """发送带 id 的 JSON-RPC 请求并返回响应。"""
        self._next_id += 1
        payload: Dict[str, Any] = {"jsonrpc": "2.0", "id": self._next_id, "method": method}
        if params is not None:
            payload["params"] = params
        return self._post(payload)

    def notify(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        """发送通知（无 id），服务端通常返回 202/204 空响应。"""
        payload: Dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        self._post(payload)

    def call_tool(self, name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        """tools/call 的薄封装，返回 structuredContent.data.result 这一层。"""
        reply = self.request("tools/call", {"name": name, "arguments": arguments})
        if reply is None:
            raise RuntimeError(f"tools/call {name} 返回了空响应")
        if "error" in reply:
            raise RuntimeError(f"tools/call {name} 失败：{json.dumps(reply['error'])[:400]}")
        result = reply.get("result") or {}
        structured = result.get("structuredContent") or {}
        if structured.get("ok") is False:
            raise RuntimeError(
                f"tools/call {name} 返回错误：{json.dumps(structured.get('error'))[:400]}"
            )
        data = structured.get("data") or {}
        # myterminal 把直接工具输出包成 data = { tool, result }
        return data.get("result", data)


# --------------------------------------------------------------------- 演示主流程


def main() -> int:
    url, headers = load_myterminal_endpoint()
    print(f"[1/5] myterminal MCP 地址：{url}")

    client = McpHttpClient(url, headers)

    # 第 2 步：initialize 拿到 mcp-session-id，再发 initialized 通知
    init = client.request(
        "initialize",
        {"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": CLIENT_INFO},
    )
    init_result = (init or {}).get("result") or {}
    if not client.session_id:
        raise RuntimeError("initialize 响应头里没有 mcp-session-id")
    # 服务端可能返回它支持的协议版本，后续请求头跟着协商结果走
    negotiated = init_result.get("protocolVersion")
    if isinstance(negotiated, str) and negotiated:
        client.protocol_version = negotiated
    print(
        "[2/5] initialize 成功：server=%s protocol=%s session=%s"
        % (
            init_result.get("serverInfo", {}).get("name", "?"),
            init_result.get("protocolVersion", "?"),
            client.session_id,
        )
    )

    client.notify("notifications/initialized")
    print("[2/5] 已发送 notifications/initialized")

    # 第 3 步：注册 root 会话，拿到 identity 凭证
    register = client.call_tool(
        "session_register",
        {"mode": "root", "name": "mcp-demo-" + uuid.uuid4().hex[:8]},
    )
    identity = register.get("identity") or {}
    if not identity.get("sessionId") or not identity.get("sessionToken"):
        raise RuntimeError(f"session_register 没有返回 identity：{json.dumps(register)[:400]}")
    token = identity["sessionToken"]
    print(
        "[3/5] session_register 成功：sessionId=%s sessionToken=<%d 字符，已隐藏>"
        % (identity["sessionId"], len(token))
    )

    # 第 4 步：以只读、最多 5 轮、120 秒超时的约束启动一个子代理
    started = client.call_tool(
        "subagent_start",
        {
            "objective": (
                "列出当前工作目录下的文件并报告数量；这是 MCP 代理演示用的只读探测任务。"
            ),
            "readOnly": True,
            "maxTurns": 5,
            "timeoutSec": 120,
            "identity": identity,
        },
    )
    task_id = started.get("taskId")
    if not task_id:
        raise RuntimeError(f"subagent_start 没有返回 taskId：{json.dumps(started)[:400]}")
    print(f"[4/5] subagent_start 成功：taskId={task_id} status={started.get('status', '?')}")

    # 第 5 步：轮询直到进入终态（completed / failed / aborted）
    deadline = time.time() + POLL_BUDGET_SEC
    status = str(started.get("status", "unknown"))
    last: Dict[str, Any] = started
    while time.time() < deadline:
        last = client.call_tool("subagent_status", {"taskId": task_id, "identity": identity})
        status = str(last.get("status", "unknown"))
        print(f"[5/5] 轮询 taskId={task_id} status={status}")
        if status in TERMINAL_STATES:
            break
        time.sleep(POLL_INTERVAL_SEC)

    if status not in TERMINAL_STATES:
        print(f"[5/5] 等待 {POLL_BUDGET_SEC:.0f}s 后仍未结束，最后状态={status}")
        return 1

    print(f"[5/5] 最终状态：{status}（taskId={task_id}）")
    summary = last.get("result") or last.get("error")
    if summary:
        text = summary if isinstance(summary, str) else json.dumps(summary)
        print("      结果摘要：" + text[:500])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 - 演示脚本：打印原因并以非零码退出
        print(f"错误：{exc}", file=sys.stderr)
        sys.exit(1)
