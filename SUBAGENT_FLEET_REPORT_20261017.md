# 子代理舰队活动实录 · 2026-10-17

> 一句话：ChatGPT 桌面端通过 MCP 驱动本机 MyTerminal，在仓库里开了一个根会话「ADR-0052 remediation」，先后派出 **9 个子代理**（2 个审查 + 7 个修复），把 ADR-0052 的安全/持久化审查发现逐个修掉。截至 17:20，代码全部在工作树里未提交，全量测试 **2180 过 / 2 挂**，还有一个子代理成了「活孤儿」卡着根会话的完工确认。

---

## 一、这套系统到底怎么转的（说人话）

```
ChatGPT 桌面端（App 里的代理界面）
   │  MCP 协议
   ▼
MyTerminal（本机常驻服务，bun run dev / src/cli.ts，pid 48072）
   │  派活 / 传话 / 收报告
   ▼
子代理执行器（每人一套 9 件内部工具：read_file / execute_cli / apply_patch …）
   │  亲自读代码、跑命令、改文件
   ▼
/Users/Admin/myterminal（git 分支 fix/adr-0052-security-persistence）
```

分工很干脆：

- **根代理不亲手修代码**。它的 1242 次工具调用里，最多的是 `subagent_status`（轮询子代理死活，178 次）、`git_status`（174 次）、`execute_cli`（240 次，跑 build / 跑针对性测试 / `ps` 盯测试进程）、`message_send`（78 次，给子代理派活和催促进度）。
- **子代理亲手干活**，但有个坑：**子代理的内部工具不过审计 facade**。本地审计日志（2962 条 tool_audit）里子代理只留下 `session_checkpoint` 两条记录（开工一条、收尾一条）——它们具体读了哪些文件、跑了哪些命令，**永久丢失**，只能从 checkpoint 的一句话摘要 + git diff 反推。这是本次复盘最大的数据边界。

---

## 二、工具账本（2962 条审计记录）

| 工具 | 次数 | 典型使用者 | 干嘛的 |
|---|---|---|---|
| subagent_status | 438 | 根代理 | 轮询子代理状态（盯梢） |
| read_file | 418 | 根代理 / 老会话 | 读文件 |
| read_file_range | 284 | 根代理 | 按行号读片段 |
| execute_cli | 258 | 根代理 240 次 | 跑命令 |
| session_checkpoint | 210 | 子代理（72 条）+ 根代理 | 进度/临终报告 |
| git_status | 188 | 根代理 174 次 | 看工作树改动 |
| list_dir | 170 | 根代理 | 列目录 |
| search_text | 146 | 根代理 | 搜代码 |
| session_list | 106 | 根代理 | 列会话 |
| subagent_start | 92 | 根代理 | 派子代理 |
| message_send / message_inbox | 92 / 82 | 根代理 | 给子代理发消息 / 收信箱 |
| find_files / git_diff | 76 / 74 | 根代理 | 找文件 / 看 diff |
| subagent_abort | 18 | 根代理 | 杀子代理 |
| apply_patch / write_file | 16 / 8 | 根代理（经 MCP 直改） | 直接改文件 |

来源分布：`mcp` 2448 条（根代理经 MCP 打的，今天的主力）、`subagent` 72 条（**全是 checkpoint**，印证数据边界）、`actions` 420 条 + `test` 22 条（10 月 1 日老会话遗留，与今天无关）。

根代理的高频命令长这样：

```
bun run build                                    ×20   （改完就构建）
bun test --timeout 120000 test/issue-224-…       ×14   （针对性测试）
ps -axo pid,etime,command | grep '[b]un test'    ×16   （盯测试进程跑完没）
git diff --stat; git diff --check                ×18   （看改动 / 查空白问题）
```

---

## 三、九个代理：谁、干嘛、怎么死的

### 审查批（16:13–16:16，父会话「Security and Persistence Review」）

| 代理 | 任务 | 结局 |
|---|---|---|
| subagent-835658a2 | 安全审查：root 权限/归属权/递归防护/沙箱/路径 symlink/readOnly 工具面/worktree 写闸/配额清理 | 16:16:06 **被父会话 abort**（父连发两条「立即提交结论、不要再扩大审查」后杀掉） |
| subagent-e78d9959 | 持久化审查：状态/事件持久化/崩溃恢复/原子性/一致性/并发写入/清理/schema | 16:16:40 **被父会话 abort**（同上） |

### 修复批（16:21 起，父会话「ADR-0052 remediation」）

| 代理 | 任务 | 结局 |
|---|---|---|
| subagent-2a95cac5 | **PER-01**：journal.ts 写盘失败传播（appendOrdered/drain 吞错假报成功） | **活孤儿**：16:21:08 开工后再没更新过会话记录；17:00 根代理查它时注册表已「Subagent not found」，但 state 里还挂着 working。它的活（journal.ts +111 行、#225 测试）在树里。根会话自 16:59:20 起 completion blocked，就卡在它身上 |
| subagent-c562ce50 | **SEC-01**：用户正则 ReDoS 防护（不能只靠脆弱启发式） | 16:33:35 **被父会话 abort**——但 security.ts +359 行（静态闸门 + 隔离子进程 + 预算三层防御）和 core-tools.ts 接线都已落树 |
| subagent-30928816 | **SEC-02**：saved-root 路径加固（symlink 穿透） | ✅ completed（16:41:54）。paths.ts 规范化层 + saved.ts + 8 个新测试 |
| subagent-0a71f755 | SEC-02 **复查**（审查者提的场景是否真被拒） | ✅ completed。确认 savedRoot 自身被换成根外 symlink 的场景已被现有实现拒绝，有测试兜底 |
| subagent-2aee02a2 | SEC-02 **尾巴**：persistScript 的顺序副作用 | ✅ completed。原来先 `mkdir` 再查真身，会在界外先把目录建出来；改成先核真身再建 |
| subagent-53531cfe | **PER-02**：registry.ts 并发 upsert 互相覆盖 | ✅ completed。每文件单写者队列（按 resolve 后的路径为 key，拒绝不毒化队列） |
| subagent-e19362b1 | **PER-03**：saved.ts 独占创建（并发写同路径 race） | 16:57:06 **撞 HTTP 402 余额不足猝死**——死前它落盘了测试文件（16:56:41，含 msg 要求的 0o600 权限断言）；死后 20 秒根代理亲手 apply_patch 补上 link() 竞态修复（16:57:26），34 秒后 rm 掉重复草稿（16:58:00）——遗言被指挥员执行了 |

**九只里四只非正常死亡**（2 abort + 1 402 + 1 失踪），但**代码全在树里**。abort 和 402 杀断的是「报告通道」，不是「工作通道」——活干到磁盘上就丢不了了。

---

## 四、代码产物清单（git 视角）

分支 `fix/adr-0052-security-persistence`，**全部未提交**（符合 AGENTS.md 的分支策略：不 push 不 merge，等用户发话）：

| 文件 | 改动 | 对应 finding |
|---|---|---|
| src/security.ts | +359 行 | SEC-01 ReDoS 三层防御 |
| src/workflows/saved.ts | +121 行 | SEC-02 + PER-03 |
| src/workflows/journal.ts | +111 行 | PER-01 写盘失败语义 |
| src/workflows/paths.ts | +87 行 | SEC-02 真身规范化 |
| src/core-tools.ts | 62 行 | SEC-01 接线 |
| src/workflows/registry.ts | +40 行 | PER-02 单写者队列 |
| 合计 | **6 文件 +705/−75** | |

新增 5 个测试文件（均未跟踪）：

```
test/issue-224-saved-root-canonical.test.mjs       （SEC-02，8 个用例）
test/issue-225-journal-write-failure-units.test.mjs （PER-01）
test/security-sec01-regex-dos.test.mjs              （SEC-01，14 个用例）
test/adr-0052-per-02-registry-upsert-queue.test.mjs （PER-02）
test/adr-0052-per-03-saved-exclusive-create.test.mjs（PER-03）
```

---

## 五、测试战况

四轮构建/测试日志都在 `.myterminal/subagent-outputs/`：

| 日志 | 时间 | 内容 |
|---|---|---|
| tui-single.log | 16:41 | TUI 单测 |
| final-build.log | 16:57 | 构建（28 字节，基本是空的） |
| final-targeted.log | 16:57 | 针对性测试 |
| adr-0052-final-full.log | 16:59 | 全量第一遍 |
| **final-full.log** | **17:00** | **全量：2180 pass / 2 fail，共 2182 个用例、171 个文件、107.77 秒** |

挂掉的 2 个：

1. `TuiController 的 Workflows 面 > 引擎没接线（端点未配）`（test/issue-232-workflows-screen.test.mjs:352）——挂在 TUI 接线，与本次改的 6 个文件无交集，**疑存量失败或环境相关，待确认**。
2. `bilingual documentation links resolve`（test/docs.test.mjs:26）——扫全仓库 .md 的相对链接；根目录和 docs/ 里堆了一批未跟踪的报告文件（TERMS.md 等），**疑似被这批文件带进坏链，待确认**。

两个都得单独跑一遍干净树才能定性，现在不下结论。

---

## 六、四个值得琢磨的点

1. **「杀死信使，信已经送到」。** 审查代理 16:16 被 abort，但它们的 findings 从 checkpoint 里活下来，40 分钟后变成了一棵代码树。这套「abort 杀报告、不杀工作」的语义，对长任务是特性也是陷阱——好处是成果不丢，坏处是**最终验收可能缺位**。PER-03 是幸运版：子代理 16:57:06 猝死后，根代理在 80 秒内认领了遗稿（16:57:26 亲手 apply_patch 补 link() 竞态修复、16:58:00 rm 重复草稿、16:58:59 重写 registry.ts）；但 PER-01（journal.ts）至今没有人类可读的完成报告，也没人补验。
2. **消息注入机制（已核实）。** 根代理 `message_send(to, body)` → 系统在发件方历史落 `message_sent`，同时生成一条 `event`（kind=message，recipientSessionId=收件方会话）→ 落入收件方会话流，落账为 `message_received` → 子代理执行器在回合边界把待收消息带进上下文。投递本身 1–5ms，但**系统只投递不管死活**：收件方已终态时再发会被 `INVALID_STATE` 拒绝（16:57:13 根代理给尸体发消息的实证）。投递成功的实证：PER-03 子代理历史里有 4 条 message_received（16:55:44 / 16:56:01 / 16:56:33 / 16:56:44），且 msg_2 要求补 0o600 断言后 40 秒测试文件落盘、断言确实在（84/129 行）——消息不止送达，还被消费了。

3. **数据边界的代价。** 子代理内部工具不过 facade，意味着这 2962 条审计里最有信息量的部分（子代理到底看了什么、信了什么）根本不存在。复盘只能靠 checkpoint 一句话 + git diff 反推。想让子代理行为可审计，得把 9 件套工具也接进 facade。

4. **孤儿会话会堵住整条流水线。** PER-01 的子代理 17:00 就查无此人了，但会话记录没人改口，根会话的 completion 从 16:59 堵到现在。缺一个「子代理心跳超时 → 自动标记 cancelled/failed」的清扫机制——活着的 working 状态是假的，比 cancelled 危险。

---

*数据来源：`~/.config/myterminal/workspaces/08e1819620808da3/`（state.json + 49 个会话 history + runtime.jsonl）、`.scratch/subagent-tool-calls-20261017.md`、`.myterminal/subagent-outputs/*.log`、git 工作树。生成于 2026-10-17 17:20（GMT+8），17:35 修订（补消息注入机制实证，修正 PER-03 遗稿认领情况）。*
