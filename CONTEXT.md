# CONTEXT

MyTerminal 的单一上下文词汇表：这里只定义**领域概念及其边界**。决策记录在 `docs/adr/`（本地件），实现细节在代码。在 issue 标题、重构提案、测试名里指称一个概念时，用本表的词，不要漂到本表明确回避的同义词上。

This is the single-context glossary for MyTerminal. It names domain concepts and their boundaries; decisions live in `docs/adr/` and mechanics live in code.

## 两条容易混的执行线 / Two execution lines that get confused

- **Session / Subagent / Skill** —— 一次对话里的身份、协作与委派。
- **Workflow / Workflow Agent / Reducer / Run** —— 一条脚本扇出几十路隔离子 agent 的批执行线。

两条线互不相干：Workflows 不复用 subagent 的执行器、记录库或全局并发池，只与它共用同一份 LLM 端点配置（ADR-0052 §1、§21③）。

### Workflow（工作流）

一条**脚本化的批执行线**：一个 JS 脚本在沙箱里扇出 N 路互相隔离的并发 agent，每路终态落盘，最后由一个 Reducer 汇总回传。Workflow 不是 Skill，也不是 Session——Skill 是一份给模型读的规程，Session 是身份与消息的上下文，Workflow 是跑起来的一批活。
不作同义词：不要用 workflow 指代 Skill 的步骤、Session 的协作流程、subagent 的任务清单，也不要用它泛指"多 agent"。

### Workflow Agent（工作流子 agent；口语"一路"）

一条 Workflow 里由 `agent()` 派发的那一路执行。默认只读；要写盘必须标 `isolation: 'worktree'`（写必隔离，工具面硬执行）。它不能再扇出、不能向人说话、不能碰父 run。
Workflow Agent 不是 Subagent：Subagent 由 `subagent_start` 起、绑定委派会话、走 subagent 的记录库与全局池；Workflow Agent 活在 workflows 模块自己的 agent loop、并发池与账本里，工具面也是模块自足的一套。两者各有一份实现属有意独立，不是重复代码。
不作同义词：worker、lane、格子（写文档时用"一路 / 这一跑"）。

### Reducer（汇总体）

Reducer 就是一个现有 subagent——被派去等一条 run 结算，醒来读索引、按需读每路文件，把结果整理成一份摘要，再经既有的 `checkpoint + message_send` 管线回传给发起方。它不是过程的控制器：不接管死亡、不自动重跑；死了就用同一个 runId 再起一个（聚合是无状态的）。
不作同义词：aggregator、summarizer、monitor、"监控者"（监控者方案已被否决）。

### Run（一次运行）

一条 Workflow 的一次执行。身份是 `runId`（`wf_` + hex），归属是启动它的那个 root 会话的 `ownerSessionId`（或其延续链）；有状态机 `running →（pausing → paused → running）→ completed | failed | cancelled`，有一套盘上产物（索引 / journal / 快照 / 终态标记 / 摘要 / outbox），也有四重自限闸门（token / 墙钟 / agent 数 / 并发窗口）。
Run 不是 Session：Session 是可审计的工作上下文，Run 是一次批执行的账。换会话、换凭证、重启都不改变一条 run 归属哪个会话。
不作同义词：job、task、batch、"会话的一次跑"。

### Session（会话）

可审计、可继承的工作上下文：身份、消息、检查点、工作区的载体。不是 Run，也不是 Workflow。
不作同义词：conversation（那是 ChatGPT 侧的对话，不等同于这里的会话）。

### Subagent（子 agent）

由 `subagent_start` 起的隔离长任务执行体：自己的上下文与 token 预算，父方只拿最终结果。Reducer 与 `mode: fork` 的技能都跑在这套机制上。
Subagent 不是 Workflow Agent：两条执行线，工具面、并发池、账本都各自独立。
不作同义词：child、delegate（delegate 是 session 委派形态，另一回事）。

### Skill（技能）

一份**给模型读的规程**（frontmatter + 正文），经 `skill()` 列出或加载：`mode: inline` 把正文交回当前回合，`mode: fork` 交给一个 subagent 去跑。技能是文本与能力包，加载它 ≠ 授权行动。
Skill 不是 Workflow：一条技能不会因为被加载就启动一条 run。本表同时修正历史措辞债——README 曾把 Skill 称作 "reusable agent workflows / 可复用智能体工作流"，那是撞名（ADR-0052 Consequences）。
随 Workflows 模块发布的内建技能叫 `workflow-authoring`：它教怎么写脚本、怎么起汇总体、守哪条轮询纪律；它的描述明确"本技能不授权启动"。
不作同义词：procedure、playbook、workflow（指技能时）。

## 盘上名词 / On-disk nouns

全部落在工作区内的库内托管根 `<workspaceDir>/.myterminal/`（gitignored），路径布局是模块单方定义的唯一新协议，随 `schemaVersion` 版本化（ADR-0052 §10、§20）。

- **index（索引，`index.json`）** —— 机器件：一次 run 的账，逐路状态与失败清单在这里。要程序化解析，一律回到索引。
- **journal（调用账，`journal.jsonl`）** —— 机器件：按调用顺序逐事件追加，是续跑重放的依据；单写者按行追加，撕裂尾行按最长良前缀截断并显式记账。
- **snapshot（终态快照，`snapshot.json`）** —— 机器件：只在终态写。
- **terminal marker（终态标记，`terminal`）** —— 结算的唯一线性化点：独占创建、所有终态路径都必须写、最后写。
- **digest（摘要文档）** —— 模板级形状，给人和模型读；不作机器契约，旧 run 的摘要永不改写。
- **settled-notice（终态消息）/ digest 消息** —— 两条不同的投递，首行 KV 带 `kind` / `runId` / `sha256`；`(runId, sha256)` 是去重键。投递至少一次，去重在消费侧。
- **worktree（隔离区）** —— 一路写盘 agent 的独立 git worktree，与 `workflows/` 并列。clean 自动删，有改动保留并回报 path + branch；磁盘上界只靠拒新增，绝不删旧，唯一减法是人来合并或丢弃。
