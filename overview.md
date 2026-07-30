# 批1 安全批审查门禁 #67 — 放行报告

## 结论：PASS ✅ → 已合并、#67 关闭、#42 放行

## 范围
- 分支 `fix/batch1-security` 相对 `main` 全 diff：**4 commit / 12 文件 / +545 −62**
- 映射：#59（ADR-0026 单源脱敏）· #57（ADR-0028 结构化错误码）· #35 A/B/C（ADR-0033 安全边角）

## 双轴审查
- **Standards**：通过。无 AI_RULES / DEV_CONSTRAINTS 违反；代码收敛为单源 `redact()` + typed error，符合既有模式。
- **Spec**：通过。ADR-0026（单源+全出口强制+红线）、ADR-0028（结构化错误码+删子串+映射测试）、ADR-0033（#35 拆解显式决策）均忠实落地。

## #67 票面六项验收（全部通过）
1. **红线测试全出口** — `bun run test` → **541 pass / 0 fail**（含 `redaction` / `error-codes` / `issue35` 三张红线网）
2. **fixture 无真实凭据** — `grep -rE 'gh[oúp]_|AKIA|eyJ|Bearer eyJ|sk-(?!test)' test/` → **0 命中**；fixture 仅用显然假值 `sk-test-*` / `errorcodes-*` / `test-*`
3. **5 处子串已删** — `extensions.ts` `failure()`、`core-tools.ts` skill-fork catch、`subagent/tools.ts` grep catch 全部改 typed error；`src/` 内已无 `message.includes(...)` 错误码猜测残留
4. **#35 有显式决策** — ADR-0033 对 #35 全部条目显式归位（重复项→#63/#49、小性能项→批5 #63、安全边角 A/B/C→**修复**）
5. **逐 commit G9 留痕** — 4 commit 均带 `issue#+ADR`，且各自捆绑红灯回归测试 + 修复
6. **全量绿** — `bun run test` 541/541；另 `bun run typecheck` 显式 exit 0

## 已执行动作（授权通过后）
- `git merge --no-ff` → merge **`32e2622`**；`git push origin main`（`b011945..32e2622`）
- 删本地 `fix/batch1-security`（无远程分支）
- **#67** 贴证据（issuecomment-5124314986）并 **CLOSED**
- **#42** 贴解除阻塞评论（issuecomment-5124319565），保持 **OPEN**（仅放行批2，不关票）

## 备注 / 后续
- 4 commit 为「红灯测试 + 修复」同 commit，未拆独立 red commit；G9 红灯证据由测试内 `RED now:` 注释 + tip 全绿共同证明
- #42 仍 Open，属批2 identity 工作，须从**新 main** 新建干净分支（旧 `fix/mcp-session-state` 为测试脏分支，不可合并）
- 下一批：批2 从新 main 拉分支，过门禁 **#68**

---

## ⚠️ CI 回归分析（2026-07-30 07:21）

push main 后 CI 触发：
- **macOS** ✅ / **ubuntu** ✅ / **Windows** ❌

### 失败细节
- 1 fail / 540 pass：`subagent-m7 > 决策 37 回归: abort 时 normalizeMessages 补齐孤儿 tool_use`
- 失败原因：`result.status !== 'aborted'`（预期 abort 返回值，实际非 aborted）
- Run: [30498623783](https://github.com/epslkslsksndnsjs-lab/myterminal/actions/runs/30498623783)

### 根因分析
- **批1 diff 未触及**：`llm-adapter.ts` / `executor.ts` / `normalizeMessages` / abort 路径均未改动；`subagent/runner.ts` 仅改 maxParallel throw→typed error，`subagent/tools.ts` 仅改 grep catch + redact import，均与失败测试无关。
- **失败测试为时序/进程派生敏感**：调用 `execute_cli sleep 60` + 500ms 窗口 + abort controller——在 Windows 进程调度下天然脆弱。
- **历史佐证**：Windows main 线已多次红（b41a6d41 symlink 2fail、e9d8a1d7 5fail 等），b011945 专门修 symlink 才绿；本次失败非批1 引入或独有的失败模式。
- **结论**：**时序 flake，非批1 代码回归。**

### 处置
- 已触发 Windows job re-run 确认（run 30498623783 re-run --failed）。
- 若 re-run 绿 → 确认为 flake，按纪律开新修复票加固该测试（不在此顺手修）。
- 若 re-run 仍红 → 需深入 Windows 环境复现。
