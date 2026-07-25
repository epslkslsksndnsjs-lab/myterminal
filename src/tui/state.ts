import { spawn } from 'node:child_process';
import path from 'node:path';
import { WorkspaceDiffTracker, type DiffSnapshot } from '../diff.js';
import { logicalSessionGroups } from '../tui-model.js';
import type { MyTerminalRuntime, RuntimeLog } from '../server.js';
import type { CustomExtensionSpec, MyTerminalSession, MyTerminalSettings, SessionPhase, StoredState, TaskPackage } from '../types.js';
import { isDirectory, isValidPublicBaseUrl, readMyTerminalSettings, rotateMyTerminalCredentials, validateSettingsFeasibility } from '../config.js';
import { describePortOwner, findAvailablePort, terminatePortOwner } from '../instances.js';
import { isAddWorkspaceSelection, selectedWorkspace } from '../workspace-selection.js';
import { buildWorkspaceSelectorModel } from './workspace-selector.js';
import { checkForUpdate, installUpdate, isSourceCheckout, type UpdateStatus } from '../update.js';
import { CURRENT_VERSION } from '../version.js';
import { commandPassiveLock, passiveLockStatus } from '../session-resources.js';
import { runtimeSettingsSnapshot } from '../runtime-settings.js';

export const TABS = ['Overview', 'Sessions', 'Messages', 'Timeline', 'Diff', 'Extensions', 'Settings', 'Logs'] as const;
export type Tab = (typeof TABS)[number];
export type { Ask, Detail, FormQuestion, RuntimeReconfigure, RuntimeReconfigureResult } from './contracts.js';
import type { Ask, Detail, FormQuestion, RuntimeReconfigure } from './contracts.js';

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

function integer(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function runWithInput(command: string, args: string[], input: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], shell: false });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
    child.stdin.end(input);
  });
}

export async function copyToHostClipboard(text: string): Promise<boolean> {
  const commands = process.platform === 'darwin'
    ? [['pbcopy', []] as const]
    : process.platform === 'win32'
      ? [['clip', []] as const]
      : [['wl-copy', []] as const, ['xclip', ['-selection', 'clipboard']] as const];
  for (const [command, args] of commands) if (await runWithInput(command, [...args], text)) return true;
  return false;
}

function bestEffortSpawn(command: string, args: string[]): void {
  const child = spawn(command, args, { stdio: 'ignore', shell: false });
  child.on('error', () => undefined);
}

function playAttentionSound(): void {
  // 暂时关闭提醒声音 —— 恢复时取消注释下方三行
  // if (process.platform === 'darwin') bestEffortSpawn('afplay', ['/System/Library/Sounds/Ping.aiff']);
  // else if (process.platform === 'win32') bestEffortSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[console]::beep(880,180)']);
  // else bestEffortSpawn('canberra-gtk-play', ['--id=dialog-warning']);
}

function notifySystem(title: string, message: string): void {
  // 暂时关闭系统通知 —— 恢复时取消注释下方三行
  // if (process.platform === 'darwin') bestEffortSpawn('osascript', ['-e', `display notification "${message.replace(/["\\]/g, '')}" with title "${title.replace(/["\\]/g, '')}"`]);
  // else if (process.platform === 'linux') bestEffortSpawn('notify-send', [title, message]);
  // else if (process.platform === 'win32') bestEffortSpawn('msg.exe', ['*', `${title}: ${message}`]);
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

  constructor(private currentRuntime: MyTerminalRuntime, private readonly reconfigure: RuntimeReconfigure) {
    this.diff = new WorkspaceDiffTracker(currentRuntime.config);
  }

  get runtime(): MyTerminalRuntime { return this.currentRuntime; }
  get zh(): boolean { return this.currentRuntime.config.uiLanguage === 'zh-CN'; }
  text(en: string, zh: string): string { return this.zh ? zh : en; }

  start(): void { this.diff.start(); void this.refreshUpdateStatus(); }

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
    const split = (value: string) => value.split(';').map((item) => item.trim()).filter(Boolean);
    const task: TaskPackage = { objective: answers[3], background: answers[4], deliverables: split(answers[5]), acceptanceCriteria: split(answers[6]), constraints: split(answers[7]) };
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
    const terminal = ['completed', 'cancelled'].includes(session.phase);
    const actions = terminal ? ['context', 'delete', 'continue'] : ['copy', 'revoke', 'cancel', 'context', 'delete'];
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
      zh: config.uiLanguage === 'zh-CN',
    });
    const workspaceItems = workspaceSelector.items;
    const passiveStatus = process.platform === 'darwin' ? passiveLockStatus(config) : { state: 'unsupported' };
    const passiveFallback = !current.passiveLockEnabled
      ? 'off'
      : /armed|arming|visible_waiting_for_arm/.test(passiveStatus.state)
        ? 'arm'
        : 'standby';
    const settingFields = ['language', 'theme', 'workspace', 'host', 'port', 'public-url', 'max-output', 'timeout', 'actions-continuation', 'non-blocking-tasks', 'passive-lock'];
    const selection = await ask([{ label: this.text('Choose settings to edit', '选择要修改的设置'), options: settingFields, multiSelect: true }], [
      this.text('Edit only the settings you choose.', '只修改你选择的设置；未选择的项目保持不变。'),
      this.text('Available fields:', '可选字段：'),
      'language, theme, workspace, host, port, public-url, max-output, timeout, actions-continuation, non-blocking-tasks, passive-lock',
    ]);
    if (!selection?.[0]) return;
    const fields = [...new Set(selection[0].split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))];
    const questions: FormQuestion[] = [];
    for (const field of fields) {
      if (field === 'language') questions.push({ label: 'UI language', fallback: current.uiLanguage, options: ['zh-CN', 'en'] });
      else if (field === 'theme') questions.push({ label: 'UI theme', fallback: current.uiTheme, options: ['dark', 'light'] });
      else if (field === 'workspace') {
        if (!workspaceItems.length) {
          this.currentRuntime.log(this.text('Workspace catalog is unavailable; workspace selection cannot continue.', '工作区目录不可用，无法继续选择工作区。'), 'error');
          return;
        }
        questions.push(workspaceSelector.question);
      }
      else if (field === 'host') questions.push({ label: this.text('Listen host', '监听地址'), fallback: current.host, validate: (value) => value.trim() ? undefined : this.text('Host cannot be empty.', '监听地址不能为空。') });
      else if (field === 'port') questions.push({ label: this.text('Listen port', '监听端口'), fallback: String(current.port), validate: (value) => { const port = Number(value); return Number.isInteger(port) && port >= 0 && port <= 65535 ? undefined : this.text('Port must be an integer from 0 to 65535.', '端口必须是 0 到 65535 的整数。'); } });
      else if (field === 'public-url') questions.push({ label: this.text('Public HTTPS URL (local clears)', '公网 HTTPS URL（local 清空）'), fallback: current.publicBaseUrl || 'local', validate: (value) => value.toLowerCase() === 'local' || isValidPublicBaseUrl(value.replace(/\/$/, '')) ? undefined : this.text('Use HTTPS; localhost may use HTTP.', '请使用 HTTPS；localhost 可使用 HTTP。') });
      else if (field === 'max-output') questions.push({ label: this.text('Maximum output characters', '最大输出字符'), fallback: String(current.maxOutputChars), validate: (value) => { const number = Number(value); return Number.isInteger(number) && number >= 4000 && number <= 1000000 ? undefined : this.text('Use an integer from 4000 to 1000000.', '请输入 4000 到 1000000 的整数。'); } });
      else if (field === 'timeout') questions.push({ label: this.text('Command timeout seconds', '命令超时秒数'), fallback: String(current.commandTimeoutSec), validate: (value) => { const number = Number(value); return Number.isInteger(number) && number >= 1 && number <= 3600 ? undefined : this.text('Use an integer from 1 to 3600.', '请输入 1 到 3600 的整数。'); } });
      else if (field === 'actions-continuation') questions.push({ label: this.text('Long-task harness', '长任务 Harness'), fallback: current.actionsContinuationMode, options: ['off', 'adaptive', 'next-call', 'lookahead-3'] });
      else if (field === 'non-blocking-tasks') questions.push({ label: this.text('Non-blocking tasks', '非阻塞任务'), fallback: current.nonBlockingTasksEnabled ? 'on' : 'off', options: ['off', 'on'] });
      else if (field === 'passive-lock') questions.push({ label: this.text('macOS passive lock', 'macOS 被动锁屏'), fallback: passiveFallback, options: ['off', 'arm', 'standby'] });
    }
    const answers = await ask(questions, [this.text(`Editing: ${fields.join(', ')}`, `正在修改：${fields.join(', ')}`)]);
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
    const next: MyTerminalSettings = { ...current };
    let passiveAction: 'off' | 'arm' | 'standby' | undefined;
    fields.forEach((field, index) => {
      const value = answers[index];
      if (field === 'language') next.uiLanguage = value as MyTerminalSettings['uiLanguage'];
      else if (field === 'theme') next.uiTheme = value as MyTerminalSettings['uiTheme'];
      else if (field === 'workspace') {
        const selected = selectedWorkspace(workspaceItems, value);
        if (!selected) throw new Error('Workspace selection did not resolve to a catalog entry.');
        next.workspaceDir = isAddWorkspaceSelection(selected) ? addedWorkspaceDir! : selected.workspaceDir;
      }
      else if (field === 'host') next.host = value;
      else if (field === 'port') next.port = integer(value, current.port);
      else if (field === 'public-url') next.publicBaseUrl = value.toLowerCase() === 'local' ? '' : value.replace(/\/$/, '');
      else if (field === 'max-output') next.maxOutputChars = integer(value, current.maxOutputChars);
      else if (field === 'timeout') next.commandTimeoutSec = integer(value, current.commandTimeoutSec);
      else if (field === 'actions-continuation') next.actionsContinuationMode = value as MyTerminalSettings['actionsContinuationMode'];
      else if (field === 'non-blocking-tasks') next.nonBlockingTasksEnabled = value === 'on';
      else if (field === 'passive-lock') { passiveAction = value.toLowerCase() as 'off' | 'arm' | 'standby'; next.passiveLockEnabled = passiveAction !== 'off'; }
    });
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
    await this.applySettings(next);
    if (process.platform === 'darwin' && passiveAction) {
      commandPassiveLock(this.currentRuntime.config, passiveAction === 'off' ? 'stop' : passiveAction);
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
