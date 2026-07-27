# 实战错误记录 E1–E8 根因分析与修复方案

> 日期：2026-07-27 · 依据：用户提供的真实执行错误记录 + 逐条代码级定位（文件:行号）
> 这份记录命中了前三份报告没覆盖的实战层：**subagent 失败无打捞、checkpoint 硬门摩擦、写文件人体工学、大文件分轮创作**。

---

## 1. 逐条根因定位

### E1/E2/E7：Subagent failed 无 result（token 超限）—— 三个叠加根因

| 层 | 证据 | 问题 |
|---|---|---|
| 错误识别 | `llm-adapter.ts:176` | overflow 只匹配 3 个英文短语（'prompt is too long' / 'context_length' / 'maximum context length'）且仅查 400。**GLM/Qwen 的中文报错（"Token 超出限制"等）和 413/422 全部漏判** → 落入 `system` 分支直接失败，**响应式 compact 根本没机会触发** |
| 失败语义 | `executor.ts:450-460` `finishFailed` | 失败时只返回 `error` 字符串。**已完成的 turns、已读/已写的文件、已有结论全部蒸发**，parent 只看到 "failed: xxx" |
| 通知内容 | `runner.ts:120-127` | 发给 parent 的消息只有错误原因，无部分结果、无重试建议 → E2 被迫"改用已知信息推理"（无据可依的瞎推） |

注：今天完成的 M3 result-budget（单条工具结果截 50K，未提交）对"读 30+ 大文件"有预防作用——若 E1/E2 是 M3 之前的运行，合并后需回归验证，但上面三个根因依然存在。

### E5：CHECKPOINT_REQUIRED x4 —— 硬门设计摩擦

`store.ts:16` `CHECKPOINT_BLOCK_MS = 5*60_000`：首次普通调用后开始计时，**5 分钟未 checkpoint → 所有普通调用直接抛错**（store.ts:301-305）。两个问题：
- **零预警**：模型在埋头干活，第 4 分 59 秒还一切正常，第 5 分钟突然全部调用被拒
- **意图丢失**：被拒的调用就这么没了，错误里不带"你刚才想干什么"，checkpoint 后模型要自己回忆重放。web 端每次硬门 ≈ 浪费 1-2 轮

### E3/E4/E6：写文件人体工学 —— shell 与 $ 的战争

- `execute_cli` 走 shell，`${}`/`$0`/反引号必被解释（E4 的 heredoc 灾难）
- 模型绕路用原生 Write 工具（E3）——因为没人告诉它"write_file 走 JSON 传输，$ 无需任何转义"
- E6 的 2 个 fmtCost 测试 fail 同理：模型生成含 `$` 内容时自己"好心"加了转义，反而污染。**这不是传输层 bug，是引导缺失**

### E8：2100 行大文件写不完 —— 缺 append 语义

web 模型单轮输出预算有限（几 K tokens/轮），2100 行 ≈ 20-40K tokens 必须分轮写。当前 `write_file` 只有全量覆写，分轮创作只能靠 `apply_patch` 找尾部锚点——脆弱且费 token。跑了 15 轮只交付 1705 行。

---

## 2. 修复方案（按优先级）

| # | 修复 | 位置/改动量 | 效果 |
|---|---|---|---|
| **F2** | **失败打捞 partialResult**：finishFailed 时用本地数据（零 LLM 成本）生成部分结果——已用 turns、工具调用清单、已写文件列表（file-state/shell-tracker 现成）、最后 assistant 文本截 500 字 → 存 subagent store + notify 带 300 字摘要 | executor.ts ~30 行 + runner.ts ~5 行 | E1/E2/E7 从"全丢"变"可打捞"，parent 能续命 |
| **F1** | **overflow 识别扩充**：匹配加 'exceeds the context'/'input length'/'too many tokens'/'token 超出'/'长度超'/'reduce the length'，状态码覆盖 400/413/422；5 家 provider 错误体各列一条样例 | llm-adapter.ts ~15 行 | 中文 provider 的溢出也能触发响应式 compact，不再直接判死 |
| **F4** | **checkpoint 软预警**：剩余 60 秒起，普通调用响应附 `checkpointDueInSec`（几十字节） | store.ts + extensions.ts ~25 行 | 模型提前主动 checkpoint，硬门基本不再触发 |
| **F5** | **被拒调用重放**：CHECKPOINT_REQUIRED 错误 details 附 `blockedCall: {tool, input}` | extensions.ts catch ~10 行 | checkpoint 后原样重放，意图零丢失，每次省 1-2 轮 |
| **F6** | **写文件引导文案**：execute_cli description 加「Never write files via shell/heredoc — $ is interpreted. Use write_file」；write_file description 加「JSON 传输，$/反引号/引号无需转义」 | core-tools.ts ~10 行文案 | E3/E4/E6 同源问题，一句话成本 |
| **F8** | **write_file 加 `mode:"append"`**（默认 overwrite 完全兼容）：大文件分轮创作 = 首轮 overwrite + 后续逐轮 append | core-tools.ts ~20 行 | E8 直接解决，2100 行类任务可分轮交付 |
| F3 | 失败 notify 附重试建议（缩 objective/降 maxTurns/分批读） | runner.ts ~5 行 | parent 自愈 |
| F7 | execute_cli 检测 heredoc 写文件模式附 warning（不拦截） | core-tools.ts ~15 行 | 可选，教育性质 |

**验证**：F1/F2 配单测（模拟 GLM 中文 overflow 错误体 + 失败时 partialResult 结构）；F4/F5 在 context-budget 回归脚本里加"连续 6 分钟不 checkpoint"场景；F8 测 append 幂等与覆写兼容。

---

## 3. 与前三份报告的合流

总优先级队列（全部只加不改、向后兼容）：

1. **F2 subagent 失败打捞** —— 实战最痛，改动小
2. **F1 overflow 识别扩充** —— 同上
3. **F4+F5 checkpoint 软预警 + 重放** —— 每次硬门省 1-2 轮
4. **F6 写文件文案** —— 一句话成本，治 E3/E4/E6
5. **P0-C agent onboarding 三件套**（前报）—— agent 直调上手
6. **P0-A discover 分片 + P0-B 输出钳制**（前报）—— Instant 32K 窗口 15 轮
7. **F8 write_file append** —— 大文件分轮创作
8. P1 文案 / P2 MCP identity 缓存 / 回归脚本

---

## References

- 用户提供的实战错误记录（E1–E8，2026-07-27）
- 代码证据：`src/store.ts:16,296-313`（CHECKPOINT_BLOCK_MS 硬门）、`src/subagent/llm-adapter.ts:173-177`（overflow 识别）、`src/subagent/executor.ts:450-460,509`（finishFailed/compact 熔断）、`src/subagent/runner.ts:107-132`（notify 内容）、`src/core-tools.ts`（write_file/execute_cli 定义）
- 前序报告：`deliverables/tool-system-agent-onboarding-2026-07-27.md`、`deliverables/tool-system-context-budget-2026-07-27.md`、`deliverables/tool-system-ux-optimization-2026-07-27.md`
