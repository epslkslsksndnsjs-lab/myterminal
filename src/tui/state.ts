import path from 'node:path';
import { WorkspaceDiffTracker, type DiffSnapshot } from '../diff.js';
import { copyToHostClipboard, notifySystem, playAttentionSound } from './host-io.js';
import { describeClockNesting, resolveWorkflowGates, validateClockNesting } from '../workflows/gates.js';
import { WORKFLOW_SETTING_FIELDS, buildChildTaskPackage, buildSettingsQuestions, parseSelectedFields, passiveLockFallback, resolveSettingsAnswers, sessionActionOptions } from './controller-logic.js';
export { copyToHostClipboard } from './host-io.js';
import { i18nFor, type I18n } from './copy/i18n.js';
import { logicalSessionGroups } from '../tui-model.js';
import type { MyTerminalRuntime, RuntimeLog } from '../server.js';
import type { CustomExtensionSpec, MyTerminalSession, MyTerminalSettings, SessionPhase, StoredState, TaskPackage } from '../types.js';
import { isDirectory, readMyTerminalSettings, rotateMyTerminalCredentials, validateSettingsFeasibility } from '../config.js';
import { describePortOwner, findAvailablePort, terminatePortOwner } from '../instances.js';
import { isAddWorkspaceSelection, selectedWorkspace } from '../workspace-selection.js';
import { buildWorkspaceSelectorModel } from './workspace-selector.js';
import { checkForUpdate, installUpdate, isSourceCheckout, type UpdateStatus } from '../update.js';
import { CURRENT_VERSION } from '../version.js';
import { commandPassiveLock, passiveLockStatus } from '../session-resources.js';
import { runtimeSettingsSnapshot } from '../runtime-settings.js';
import { runPaths } from '../workflows/paths.js';
import type { WorkflowEvent } from '../workflows/events.js';
import { EMPTY_RUN_BOARD, applyWorkflowEvent, buildRunBoard, describeInterruptedRuns, diskRunBoardSource, interruptedRuns, resumeCallText, type InterruptedNotice, type RunBoard } from './workflow-runs.js';
import type { Translate } from './copy/i18n.js';

export const TABS = ['Overview', 'Sessions', 'Messages', 'Timeline', 'Diff', 'Extensions', 'Settings', 'Logs', 'Subagents', 'Worktrees', 'Workflows'] as const;
export type Tab = (typeof TABS)[number];
export type { Ask, Detail, FormQuestion, RuntimeReconfigure, RuntimeReconfigureResult } from './contracts.js';
import type { Ask, Detail, RuntimeReconfigure } from './contracts.js';

export type { Theme } from './theme/index.js';
export { themeFor } from './theme/index.js';
import type { Theme } from './theme/index.js';

export function phaseColor(theme: Theme, phase: SessionPhase): string {
  if (phase === 'completed') return theme.good;
  if (phase === 'working') return theme.accent;
  if (phase === 'blocked' || phase === 'cancelled') return theme.bad;
  return theme.warn;
}

export function presenceColor(theme: Theme, session: MyTerminalSession): string {
  if (session.presence === 'claimed') return theme.good;
  if (session.presence === 'stale') return theme.bad;
  return theme.warn;
}

export type TuiSnapshot = {
  state: StoredState;
  diff: DiffSnapshot;
  logs: RuntimeLog[];
  runtime: MyTerminalRuntime;
  update: UpdateStatus;
};

export class TuiController {
  private diff: WorkspaceDiffTracker;
  private snapshotCache?: { revision: string; snapshot: TuiSnapshot };
  private readonly handoffs = new Map<string, string>();
  private readonly remindedAt = new Map<string, { sound: number; notification: number }>();
  private stopped = false;
  private update: UpdateStatus = { currentVersion: CURRENT_VERSION, updateAvailable: false, checking: true };
  /**
   * Workflows 屏的投影（#232）：冷启动扫盘填，热路径事件就地改。
   * 渲染期只读这一份，不在渲染里调 I/O；修订号进 renderRevision，快 tick 才看得见它。
   */
  private workflowBoardValue: RunBoard = EMPTY_RUN_BOARD;
  private workflowRevisionValue = 0;
  private workflowUnsub: () => void = () => {};
  private workflowScan?: Promise<void>;
  private workflowScanQueued = false;
  private readonly workflowListeners = new Set<() => void>();

  constructor(private currentRuntime: MyTerminalRuntime, private readonly reconfigure: RuntimeReconfigure) {
    this.diff = new WorkspaceDiffTracker(currentRuntime.config);
  }

  get runtime(): MyTerminalRuntime { return this.currentRuntime; }
  /** 语言判定收敛到 copy/i18n.ts 单源（#31）；以下三个成员只是它的转发面，语义不变。 */
  get i18n(): I18n { return i18nFor(this.currentRuntime.config.uiLanguage); }
  get zh(): boolean { return this.i18n.zh; }
  text(en: string, zh: string): string { return this.i18n.t(en, zh); }

  start(): void { this.diff.start(); void this.refreshUpdateStatus(); this.subscribeWorkflow(); }

  /**
   * Workflows 事件的订阅（接线 #5 的热路径）。换 runtime（设置里重配）时要重订一次，
   * 订阅的是新进程里那台引擎，不是被换掉的旧引用。
   */
  private subscribeWorkflow(): void {
    this.workflowUnsub();
    this.workflowUnsub = this.currentRuntime.onWorkflowEvent((event) => this.onWorkflowProgress(event));
    this.scheduleWorkflowScan();
  }

  /** Workflows 屏读的那份投影（同步；渲染期不碰盘）。 */
  workflowBoard(): RunBoard { return this.workflowBoardValue; }

  /** 投影变了就通知一次——App 用它把刷新推到下一帧，不等 150ms 的快 tick。 */
  onWorkflowBoardChange(listener: () => void): () => void {
    this.workflowListeners.add(listener);
    return () => { this.workflowListeners.delete(listener); };
  }

  /**
   * 冷启动那一半：扫 run 目录，从持久件（index.json）重建。
   * 扫出来的不会比投影旧——在跑的那几条一律先取本进程那份活索引（diskRunBoardSource 的读序），
   * 所以扫完直接换上就是最新的账。
   */
  async refreshWorkflowBoard(): Promise<RunBoard> {
    const paths = this.currentRuntime.workflowLayout();
    if (!paths) return this.publishWorkflowBoard(EMPTY_RUN_BOARD);
    return this.publishWorkflowBoard(await buildRunBoard(diskRunBoardSource({
      paths,
      liveIndex: (runId) => this.currentRuntime.liveWorkflowRun(runId),
      liveRunIds: () => this.currentRuntime.liveWorkflowRunIds(),
    })));
  }

  private publishWorkflowBoard(next: RunBoard): RunBoard {
    if (next === this.workflowBoardValue) return next;
    this.workflowBoardValue = next;
    this.workflowRevisionValue += 1;
    for (const listener of [...this.workflowListeners]) listener();
    return next;
  }

  private onWorkflowProgress(event: WorkflowEvent): void {
    const paths = this.currentRuntime.workflowLayout();
    if (!paths) return;
    this.publishWorkflowBoard(applyWorkflowEvent(this.workflowBoardValue, event, {
      liveIndex: (runId) => this.currentRuntime.liveWorkflowRun(runId),
      indexPath: (runId) => runPaths(paths, runId).indexFile,
    }));
    // 投影只能改已知的行与在跑的账：别处新起的那一条要靠扫盘才看得见。
    this.scheduleWorkflowScan();
  }

  /** 扫盘合流：一路 run 几十条事件不该引出几十次扫描，在飞的这一次扫完再补扫一遍就够。 */
  private scheduleWorkflowScan(): void {
    if (this.workflowScan) { this.workflowScanQueued = true; return; }
    this.workflowScan = (async () => {
      do {
        this.workflowScanQueued = false;
        await this.refreshWorkflowBoard();
      } while (this.workflowScanQueued && !this.stopped);
    })().finally(() => { this.workflowScan = undefined; });
  }

  /** 启动提示："上次被打断的 run"（§12），永不让提示把启动搭进去。 */
  workflowInterruptedNotice(t: Translate): InterruptedNotice | undefined {
    return describeInterruptedRuns(interruptedRuns(this.workflowBoardValue), t, { now: Date.now() });
  }

  /** 可复制的 resume 调用文本；给不出就是给不出，不编一条必然被拒的。 */
  workflowResumeCall(runId: string | undefined): string | undefined {
    if (!runId) return undefined;
    const row = this.workflowBoardValue.rows.find((item) => item.runId === runId);
    return row ? resumeCallText(row, { annotate: true }) : undefined;
  }

  snapshot(): TuiSnapshot {
    const revision = this.renderRevision();
    if (this.snapshotCache?.revision === revision) return this.snapshotCache.snapshot;
    const snapshot = { state: this.currentRuntime.store.snapshotForTui(), diff: this.diff.snapshot(), logs: [...this.currentRuntime.logs], runtime: this.currentRuntime, update: { ...this.update } };
    this.snapshotCache = { revision, snapshot };
    return snapshot;
  }

  renderRevision(): string {
    return [
      this.currentRuntime.store.revision(),
      this.currentRuntime.runtimeLogRevision(),
      this.diff.revision(),
      this.update.checking, this.update.latestVersion || '', this.update.error || '',
      this.currentRuntime.runtimeHealth().phase,
      this.currentRuntime.l3Health()?.status ?? 'off',
      this.workflowRevisionValue,
    ].join(':');
  }

  async refreshDiff(): Promise<void> { await this.diff.refresh(); }

  async refreshUpdateStatus(): Promise<void> {
    this.update = { ...this.update, checking: true, error: undefined };
    this.update = await checkForUpdate();
    if (this.update.updateAvailable) this.currentRuntime.log(`Update available: ${this.update.currentVersion} -> ${this.update.latestVersion}`, 'info');
  }

  async updateApplication(ask: Ask): Promise<void> {
    await this.refreshUpdateStatus();
    if (!this.update.updateAvailable || !this.update.latestVersion) {
      this.currentRuntime.log(this.update.error || this.text('MyTerminal is already up to date.', 'MyTerminal 已是最新版本。'));
      return;
    }
    if (isSourceCheckout()) {
      this.currentRuntime.log(this.text('One-click update is disabled for a Git source checkout. Pull and review changes manually.', 'Git 源码工作区已禁用一键更新，请手动拉取并审查更改。'), 'error');
      return;
    }
    const answer = await ask([{ label: this.text(`Install ${this.update.latestVersion} now?`, `立即安装 ${this.update.latestVersion}？`), fallback: 'no', options: ['yes', 'no'] }]);
    if (!answer || !['yes', 'y'].includes(answer[0].toLowerCase())) return;
    this.currentRuntime.log(`Installing MyTerminal ${this.update.latestVersion}...`);
    const clusterVersions = this.currentRuntime.clusterVersions();
    const members = this.currentRuntime.clusterMemberCount();
    await installUpdate(this.update.latestVersion, {
      restartReason: 'tui_update_requested',
      runtimeLog: (message, level) => this.currentRuntime.log(message, level),
    });
    this.update = { ...this.update, updateAvailable: false, restartRequired: true, runningClusterVersions: clusterVersions };
    this.currentRuntime.log(this.text(
      `Update installed without stopping ${members} running process(es). Existing Apps/Actions service remains online. Restart each TUI individually to move the cluster to ${this.update.latestVersion}; restart the current leader last for the smallest interruption.`,
      `更新已安装，未终止正在运行的 ${members} 个进程，现有 Apps/Actions 服务保持在线。请逐个重启 TUI 以切换到 ${this.update.latestVersion}，最后重启当前 leader 可将中断降到最低。`,
    ));
  }


  tickReminders(): void {
    this.currentRuntime.store.refreshTemporalStates();
    const now = Date.now();
    const pending = this.currentRuntime.store.pendingUnclaimed();
    const ids = new Set(pending.map((session) => session.id));
    for (const id of this.remindedAt.keys()) if (!ids.has(id)) { this.remindedAt.delete(id); this.handoffs.delete(id); }
    for (const session of pending) {
      if (!this.handoffs.has(session.id)) {
        const prompt = this.currentRuntime.store.handoffForTui(session.id);
        if (prompt) void this.rememberAndCopy(session.id, prompt);
      }
      const times = this.remindedAt.get(session.id) || { sound: now, notification: now };
      if (now - times.sound >= 60_000) { playAttentionSound(); times.sound = now; }
      if (now - times.notification >= 300_000) {
        notifySystem('MyTerminal', `${session.name} ${this.text('still needs a controller.', '仍等待 ChatGPT 接管。')}`);
        times.notification = now;
      }
      this.remindedAt.set(session.id, times);
    }
  }

  async createSession(ask: Ask): Promise<void> {
    const roots = this.currentRuntime.store.listSessions().filter((session) => !session.parentSessionId && !['completed', 'cancelled'].includes(session.phase));
    const first = await ask([{ label: this.text('Create root or child', '创建 root 或 child'), fallback: roots.length ? 'child' : 'root', options: ['root', 'child'] }]);
    if (!first) return;
    if (first[0] === 'root') {
      const answers = await ask([{ label: this.text('Root session name', 'Root session 名称') }, { label: this.text('Role', '角色'), fallback: 'lead' }]);
      if (!answers?.[0]) return;
      const created = this.currentRuntime.store.createTuiRoot({ name: answers[0], role: answers[1] });
      await this.rememberAndCopy(created.session.id, created.handoffPrompt);
      this.currentRuntime.log(`Prepared root session ${answers[0]}; handoff copied.`);
      return;
    }
    const answers = await ask([
      { label: this.text('Root session name or ID', 'Root session 名称或 ID'), fallback: roots[0]?.id },
      { label: this.text('Child session name', '子 session 名称') },
      { label: this.text('Role', '角色'), fallback: 'developer' },
      { label: this.text('Objective', '目标'), multiline: true },
      { label: this.text('Background', '背景'), multiline: true },
      { label: this.text('Deliverables (semicolon separated)', '交付物（分号分隔）'), multiline: true },
      { label: this.text('Acceptance criteria (semicolon separated)', '验收标准（分号分隔）'), multiline: true },
      { label: this.text('Constraints (semicolon separated)', '约束（分号分隔）'), fallback: this.text('Stay within scope', '保持在任务范围内'), multiline: true },
    ]);
    if (!answers?.[0] || !answers[1]) return;
    const task: TaskPackage = buildChildTaskPackage(answers);
    const result = this.currentRuntime.store.createTuiDelegate(answers[0], { name: answers[1], role: answers[2], task });
    await this.rememberAndCopy(result.session.id, result.handoffPrompt);
    this.currentRuntime.log(`Created child ${answers[1]}; handoff copied.`);
  }

  async sessionAction(candidates: MyTerminalSession[], ask: Ask): Promise<Detail | undefined> {
    if (!candidates.length) return;
    let session = candidates[0];
    if (candidates.length > 1) {
      const targetAnswers = await ask([{
        label: this.text('Session to operate on', '选择操作对象'),
        fallback: session.id,
        options: candidates.map((item) => item.id),
        optionLabels: candidates.map((item) => [
          `${item.parentSessionId ? this.text('Child', '子 session') : item.continuesSessionId ? this.text('Continuation', '续作记录') : this.text('Root', '根 session')} · ${item.name}`,
          item.id,
          `${item.role} · ${item.phase}/${item.presence}`,
        ].join('\n')),
        optionsLayout: 'column',
      }], [this.text('Choose the exact session before selecting an action.', '先选择具体 session，再选择要执行的操作。')]);
      if (!targetAnswers?.[0]) return;
      const selected = candidates.find((item) => item.id === targetAnswers[0]);
      if (!selected) return;
      session = selected;
    }
    const { terminal, actions } = sessionActionOptions(session);
    const targetType = session.parentSessionId ? this.text('Child session', '子 session') : session.continuesSessionId ? this.text('Continuation record', '续作记录') : this.text('Root session', '根 session');
    const answers = await ask([{ label: this.text('Action for selected session', '对所选 session 执行操作'), fallback: 'context', options: actions }], [
      `${this.text('Target', '操作对象')}: ${targetType} · ${session.name}`,
      `${this.text('ID', 'ID')}: ${session.id}`,
      `${this.text('State', '状态')}: ${session.phase}/${session.presence}`,
      session.latestCheckpoint?.summary || this.text('No checkpoint summary.', '暂无 checkpoint 总结。'),
    ]);
    if (!answers) return;
    const action = answers[0].toLowerCase();
    if (action === 'copy') {
      const prompt = this.handoffs.get(session.id) || this.currentRuntime.store.handoffForTui(session.id);
      if (!prompt) { this.currentRuntime.log(`No passive handoff exists for ${session.name}; use revoke explicitly.`); return; }
      await this.rememberAndCopy(session.id, prompt);
      this.currentRuntime.log(`Handoff copied for ${session.name}.`);
    } else if (action === 'revoke') {
      if (terminal) { this.currentRuntime.log(`${session.name} is terminal; create a continuation instead.`); return; }
      const result = this.currentRuntime.store.revokeFromTui(session.id);
      await this.rememberAndCopy(session.id, result.handoffPrompt);
      this.currentRuntime.log(`Controller revoked for ${session.name}.`);
    } else if (action === 'cancel') {
      this.currentRuntime.store.cancelFromTui(session.id);
      this.handoffs.delete(session.id); this.remindedAt.delete(session.id);
      this.currentRuntime.log(`Cancelled session ${session.name}.`);
    } else if (action === 'delete') {
      await this.deleteSession(session, ask);
    } else if (action === 'continue') {
      if (!terminal || session.parentSessionId) { this.currentRuntime.log('Only a terminal root can be continued here.'); return; }
      const continuation = await ask([{ label: this.text('Continuation name', '续作名称'), fallback: `${session.name}-next` }]);
      if (!continuation?.[0]) return;
      const created = this.currentRuntime.store.createTuiRoot({ name: continuation[0], role: session.role, continuesSessionId: session.id });
      await this.rememberAndCopy(created.session.id, created.handoffPrompt);
      this.currentRuntime.log(`Created continuation ${continuation[0]}.`);
    } else if (action === 'context') {
      const group = logicalSessionGroups(this.currentRuntime.store.listSessions()).find((item) => item.sessions.some((record) => record.id === session.id) || item.children.some((child) => child.id === session.id));
      if (group) return { kind: 'session', id: group.id };
    }
  }

  async sendMessage(ask: Ask): Promise<void> {
    const sessions = this.currentRuntime.store.listSessions().filter((session) => !['completed', 'cancelled'].includes(session.phase));
    if (!sessions.length) {
      this.currentRuntime.log(this.text('No active sessions are available to receive a message.', '当前没有可接收消息的活动 session。'));
      return;
    }
    const options = sessions.map((session) => session.id);
    const labels = sessions.map((session) => `${session.name} · ${session.role} · ${session.phase}/${session.presence}`);
    const answers = await ask([
      { label: this.text('Recipient session', '接收消息的 session'), fallback: options[0], options, optionLabels: labels },
      { label: this.text('Message from user', '用户消息'), multiline: true },
    ]);
    if (answers?.[0] && answers[1]) this.currentRuntime.store.sendUserMessage(answers[0], answers[1]);
  }

  async addExtension(ask: Ask): Promise<void> {
    const first = await ask([{ label: 'Extension name (lower_snake_case)' }, { label: this.text('Title', '标题') }, { label: this.text('Description', '说明'), multiline: true }, { label: 'Handler', fallback: 'builtin', options: ['builtin', 'command'] }]);
    if (!first?.[0]) return;
    const base = { name: first[0], title: first[1] || first[0], description: first[2] || 'Custom declarative extension registered from the MyTerminal TUI.' };
    let spec: CustomExtensionSpec;
    if (first[3] === 'command') {
      const values = await ask([{ label: 'Executable' }, { label: 'Argument templates JSON', fallback: '[]', multiline: true }, { label: 'Input JSON Schema', fallback: '{"type":"object","properties":{},"additionalProperties":false}', multiline: true }, { label: 'Read-only', fallback: 'no', options: ['yes', 'no'] }]);
      if (!values) return;
      spec = { ...base, inputSchema: JSON.parse(values[2]), annotations: { readOnlyHint: values[3] === 'yes', destructiveHint: values[3] !== 'yes', openWorldHint: true, idempotentHint: values[3] === 'yes' }, handler: { kind: 'command', executable: values[0], args: JSON.parse(values[1]) } };
    } else {
      const values = await ask([{ label: 'Builtin target', fallback: 'run_checks' }, { label: 'Input JSON Schema', fallback: '{"type":"object","properties":{},"additionalProperties":false}', multiline: true }]);
      if (!values) return;
      spec = { ...base, inputSchema: JSON.parse(values[1]), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false }, handler: { kind: 'builtin', target: values[0] } };
    }
    const result = await this.currentRuntime.extensions.registerFromTui({ action: 'upsert', spec });
    this.currentRuntime.log(result.ok ? `Registered extension ${first[0]}` : result.error?.message || 'Extension registration failed', result.ok ? 'info' : 'error');
  }

  async removeExtension(name: string | undefined, ask: Ask): Promise<void> {
    const answers = await ask([{ label: this.text('Extension name to remove', '要删除的扩展名称'), fallback: name }]);
    if (!answers?.[0]) return;
    const result = await this.currentRuntime.extensions.registerFromTui({ action: 'remove', name: answers[0] });
    this.currentRuntime.log(result.ok ? `Removed extension ${answers[0]}` : result.error?.message || 'Extension removal failed', result.ok ? 'info' : 'error');
  }

  /**
   * Worktrees 面板的丢弃（#231：唯一减法 = 人）。
   * 显式二次确认——有改动的件是别人留下的工作，误删不可逆（分支没合并时 git 会拒删分支，
   * 那条留下的分支是唯一的恢复线索，所以确认文案里把它说清楚）。
   */
  async discardWorktree(id: string | undefined, ask: Ask): Promise<void> {
    if (!id) return;
    const answers = await ask([
      { label: this.text(`Discard ${id}? Unmerged work in it is deleted. The branch stays if it holds commits.`, `丢弃 ${id}？其中未合并的改动会被删除；若分支上有提交，分支保留。`), fallback: 'no', options: ['yes', 'no'] },
    ]);
    if (!answers?.[0] || answers[0].toLowerCase() !== 'yes') return;
    const result = await this.currentRuntime.discardWorktree(id, 'tui');
    this.currentRuntime.log(
      result.ok ? `Discarded worktree ${id}` : ('message' in result ? result.message : `Worktree discard failed for ${id}`),
      result.ok ? 'info' : 'error',
    );
  }

  /**
   * Workflows 屏的取消（#232）：整 run 的终态动作，且不可逆（在飞的路随中止停），
   * 所以走一次显式确认——与 discardWorktree 同一档；pause / resume 可逆，直接受理。
   */
  async cancelWorkflowRun(runId: string | undefined, ask: Ask): Promise<void> {
    if (!runId) return;
    const answer = await ask([{
      label: this.text(`Cancel ${runId}? In-flight paths stop where they are and the run settles as cancelled; results already on disk stay.`, `取消 ${runId}？在飞的路就地停，整个 run 结算为 cancelled；已经落盘的结果都留着。`),
      fallback: 'no',
      options: ['yes', 'no'],
    }]);
    if (!answer || answer[0].toLowerCase() !== 'yes') return;
    await this.controlWorkflow('cancel', runId);
  }

  async pauseWorkflowRun(runId: string | undefined): Promise<void> {
    if (runId) await this.controlWorkflow('pause', runId);
  }

  async resumeWorkflowRun(runId: string | undefined): Promise<void> {
    if (runId) await this.controlWorkflow('resume', runId);
  }

  private async controlWorkflow(op: 'cancel' | 'pause' | 'resume', runId: string): Promise<void> {
    const result = await this.currentRuntime.controlWorkflowRun(op, runId);
    if (result.ok) {
      this.currentRuntime.log(this.text(`Workflow ${runId} → ${result.status}`, `工作流 ${runId} → ${result.status}`));
      await this.refreshWorkflowBoard();
      return;
    }
    this.currentRuntime.log(result.message, 'error');
  }

  /** 把 resume 调用文本放到剪贴板；拿不到就把文本原样打到日志里，不谎报已复制。 */
  async copyWorkflowResumeCall(runId: string | undefined): Promise<void> {
    if (!runId) return;
    const call = this.workflowResumeCall(runId);
    if (!call) {
      this.currentRuntime.log(this.text('This run offers no resume call: its script reference is gone.', '这条 run 给不出 resume 调用：脚本引用已不在。'), 'error');
      return;
    }
    if (await copyToHostClipboard(call)) this.currentRuntime.log(this.text('Resume call copied.', 'resume 调用已复制。'));
    else this.currentRuntime.log(this.text(`Clipboard unavailable, copy it yourself: ${call}`, `剪贴板不可用，请自己复制：${call}`), 'error');
  }

  async editSettings(ask: Ask): Promise<void> {
    const config = this.currentRuntime.config;
    const persisted = readMyTerminalSettings();
    const current = runtimeSettingsSnapshot(this.currentRuntime, persisted);
    const knownWorkspaces = this.currentRuntime.workspaceCatalog.snapshot();
    const workspaceSelector = buildWorkspaceSelectorModel({
      label: this.text('Workspace', '工作区'),
      records: knownWorkspaces,
      currentWorkspaceDir: current.workspaceDir,
      currentRuntime: {
        workspaceDir: config.workspaceDir,
        host: config.host,
        port: this.currentRuntime.port,
        pid: process.pid,
      },
      t: this.i18n.t,
    });
    const workspaceItems = workspaceSelector.items;
    const passiveStatus = process.platform === 'darwin' ? passiveLockStatus(config) : { state: 'unsupported' };
    const passiveFallback = passiveLockFallback(current.passiveLockEnabled, passiveStatus.state);
    const settingFields = ['language', 'theme', 'workspace', 'host', 'port', 'public-url', 'max-output', 'timeout', 'actions-continuation', 'non-blocking-tasks', 'passive-lock', ...WORKFLOW_SETTING_FIELDS];
    const selection = await ask([{ label: this.text('Choose settings to edit', '选择要修改的设置'), options: settingFields, multiSelect: true }], [
      this.text('Edit only the settings you choose.', '只修改你选择的设置；未选择的项目保持不变。'),
      this.text('Available fields:', '可选字段：'),
      ['language, theme, workspace, host, port, public-url, max-output, timeout, actions-continuation, non-blocking-tasks, passive-lock', ...WORKFLOW_SETTING_FIELDS].join(', '),
    ]);
    if (!selection?.[0]) return;
    const fields = parseSelectedFields(selection[0]);
    const built = buildSettingsQuestions(fields, {
      current,
      workspaceQuestion: workspaceItems.length ? workspaceSelector.question : undefined,
      passiveFallback,
      text: this.i18n.t,
    });
    if (!built.ok) {
      this.currentRuntime.log(this.text('Workspace catalog is unavailable; workspace selection cannot continue.', '工作区目录不可用，无法继续选择工作区。'), 'error');
      return;
    }
    const answers = await ask(built.questions, [this.text(`Editing: ${fields.join(', ')}`, `正在修改：${fields.join(', ')}`)]);
    if (!answers) return;
    let addedWorkspaceDir: string | undefined;
    const workspaceFieldIndex = fields.indexOf('workspace');
    if (workspaceFieldIndex >= 0) {
      const selected = selectedWorkspace(workspaceItems, answers[workspaceFieldIndex]);
      if (!selected) throw new Error('Workspace selection did not resolve to a catalog entry.');
      if (isAddWorkspaceSelection(selected)) {
        const pathAnswer = await ask([{
          label: this.text('New workspace path', '新的工作区路径'),
          fallback: current.workspaceDir,
          validate: (value) => isDirectory(value)
            ? undefined
            : this.text('Workspace must be an accessible directory.', '工作区必须是可访问的目录。'),
        }], [this.text('Enter the directory to add and open.', '输入要添加并打开的目录。')]);
        if (!pathAnswer) return;
        addedWorkspaceDir = pathAnswer[0];
      }
    }
    const { next, passiveAction } = resolveSettingsAnswers(fields, answers, current, { items: workspaceItems, addedWorkspaceDir });
    if (process.platform !== 'darwin' && passiveAction && passiveAction !== 'off') {
      this.currentRuntime.log(this.text('Passive lock is available only on macOS.', '被动锁屏目前仅支持 macOS。'), 'error');
      return;
    }
    const errors = await validateSettingsFeasibility(next, { host: config.host, port: this.currentRuntime.port });
    const conflict = errors.find((error) => error.includes('already in use'));
    if (conflict) {
      const decision = await ask([{ label: `${this.text('Port occupied by another program', '端口被其他程序占用')} · ${describePortOwner(next.port)}`, fallback: 'cancel', options: ['kill', 'next', 'cancel'] }]);
      const policy = decision?.[0].toLowerCase() || 'cancel';
      try {
        if (policy === 'kill') await terminatePortOwner(next.port);
        else if (policy === 'next') next.port = await findAvailablePort(next.host, next.port);
        else { this.currentRuntime.log(conflict, 'error'); return; }
      } catch (error) { this.currentRuntime.log(error instanceof Error ? error.message : String(error), 'error'); return; }
    } else if (errors.length) { this.currentRuntime.log(errors.join(' '), 'error'); return; }
    // 时钟嵌套不变量：调完就破嵌套的答案不该等到 run 启动才炸（那时只剩一条 FORBIDDEN）。
    const nesting = validateClockNesting(resolveWorkflowGates(next.workflows, process.env).gates);
    if (!nesting.ok) {
      this.currentRuntime.log(this.text(`Workflow clocks must stay nested: ${describeClockNesting(nesting.violations)}`, `工作流时钟必须保持嵌套：${describeClockNesting(nesting.violations)}`), 'error');
      return;
    }
    await this.applySettings(next);
    if (process.platform === 'darwin' && passiveAction) {
      await commandPassiveLock(this.currentRuntime.config, passiveAction === 'off' ? 'stop' : passiveAction);
      const status = passiveLockStatus(this.currentRuntime.config);
      this.currentRuntime.log(this.text(`Passive lock: ${status.state}`, `被动锁屏：${status.state}`));
    }
  }

  async rotateCredentials(ask: Ask): Promise<void> {
    const answers = await ask([{ label: this.text('Rotate Apps and Actions credentials?', '轮换 Apps 与 Actions 凭据？'), fallback: 'no', options: ['yes', 'no'] }]);
    if (answers?.[0].toLowerCase() !== 'yes') return;
    const current = readMyTerminalSettings();
    if (!current) { this.currentRuntime.log('Persistent settings unavailable.', 'error'); return; }
    await this.applySettings(rotateMyTerminalCredentials(current));
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.workflowUnsub();
    this.workflowListeners.clear();
    this.diff.stop();
    await this.currentRuntime.close();
  }

  private async applySettings(next: MyTerminalSettings): Promise<void> {
    const previousDiff = this.diff;
    previousDiff.stop();
    try {
      const result = await this.reconfigure(next);
      this.currentRuntime = result.runtime;
      this.diff = new WorkspaceDiffTracker(this.currentRuntime.config);
      this.snapshotCache = undefined;
      this.diff.start();
      // 事件源跟着引擎一起换：继续握着旧 runtime 的订阅 = 新 runtime 的进度这条屏再也看不见。
      this.subscribeWorkflow();
      this.currentRuntime.log(result.error || 'Runtime settings applied from TUI.', result.error ? 'error' : 'info');
    } catch (error) {
      previousDiff.start();
      throw error;
    }
  }

  private async deleteSession(session: MyTerminalSession, ask: Ask): Promise<void> {
    const descendants = this.currentRuntime.store.listSessions().filter((item) => item.parentSessionId === session.id);
    const historyCount = [session.id, ...descendants.map((item) => item.id)].reduce((sum, id) => sum + this.currentRuntime.store.historyCount(id), 0);
    const messages = this.currentRuntime.store.messagesForSession(session.id, 1000).length;
    const phrase = `DELETE ${session.id}`;
    const answer = await ask([{ label: `${this.text('Type to confirm', '输入确认短语')} “${phrase}”` }], [
      this.text('DELETE SESSION — review before confirming', '删除 SESSION — 请确认具体内容'),
      `${this.text('Name', '名称')}: ${session.name}`,
      `ID: ${session.id}`,
      `${this.text('State', '状态')}: ${session.phase}/${session.presence}`,
      `${this.text('Objective', '目标')}: ${session.task?.objective || '-'}`,
      `${this.text('Latest checkpoint', '最近 checkpoint')}: ${session.latestCheckpoint?.summary || '-'}`,
      `${this.text('Final summary', '最终总结')}: ${session.finalSummary || '-'}`,
      `${this.text('Children', '子 Sessions')}: ${descendants.map((item) => item.name).join(', ') || '-'}`,
      `${this.text('Permanent history entries', '永久历史条目')}: ${historyCount}`,
      `${this.text('Related messages', '相关消息')}: ${messages}`,
      this.text('This removes the session, descendants, and their history.', '这会删除该 session、其子项及永久历史。'),
    ]);
    if (!answer) return;
    const result = this.currentRuntime.store.deleteFromTui(session.id, answer[0]);
    this.currentRuntime.log(`Deleted ${result.deleted.length} session record(s) and histories.`);
  }

  private async rememberAndCopy(sessionId: string, prompt: string): Promise<void> {
    this.handoffs.set(sessionId, prompt);
    this.remindedAt.set(sessionId, { sound: Date.now(), notification: Date.now() });
    if (!await copyToHostClipboard(prompt)) this.currentRuntime.log(`Clipboard unavailable. Handoff: ${prompt}`, 'error');
  }
}

export function hiddenAppsUrl(runtime: MyTerminalRuntime, reveal: boolean): string {
  return reveal ? runtime.appsUrl : runtime.appsUrl.replace(runtime.config.connectorKey, '••••••••');
}
