import path from 'node:path';
import { useTerminalDimensions } from '@opentui/react';
import { useState } from 'react';
import { validateSettings, validateSettingsFeasibility } from '../config.js';
import { describePortOwner, findAvailablePort, resolveWorkspaceInput, terminatePortOwner, type WorkspaceRecord } from '../instances.js';
import { isAddWorkspaceSelection, selectedWorkspace } from '../workspace-selection.js';
import type { MyTerminalSettings } from '../types.js';
import { themeFor, type FormQuestion } from './state.js';
import { FormDialog } from './components/FormDialog.js';
import { buildWorkspaceSelectorModel } from './workspace-selector.js';
import { Mascot } from './components/Mascot.js';

function integer(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function Setup({ defaults, records, mouseEnabled = true, onComplete, onCancel }: { defaults: MyTerminalSettings; records: WorkspaceRecord[]; mouseEnabled?: boolean; onComplete: (settings: MyTerminalSettings) => void; onCancel: () => void }) {
  const { width, height } = useTerminalDimensions();
  const [attempt, setAttempt] = useState(0);
  const [pendingConflict, setPendingConflict] = useState<{ candidate: MyTerminalSettings; message: string }>();
  const [feedback, setFeedback] = useState<string[]>([
    'MyTerminal · 首次设置 / First-run setup',
    '所有配置都保存在 TUI 中，不需要手动编辑配置文件。',
  ]);
  const theme = themeFor(defaults.uiTheme);
  const knownWorkspaces = records;
  const workspaceSelector = buildWorkspaceSelectorModel({
    label: '选择工作区 / Select workspace',
    records: knownWorkspaces,
    currentWorkspaceDir: defaults.workspaceDir,
    zh: defaults.uiLanguage === 'zh-CN',
  });
  const workspaceItems = workspaceSelector.items;
  const questions: FormQuestion[] = pendingConflict ? [
    { label: `端口被非 MyTerminal 程序占用 / Port occupied · ${describePortOwner(pendingConflict.candidate.port)}`, fallback: 'cancel', options: ['kill', 'next', 'cancel'] },
  ] : [
    { label: '界面语言 / UI language', fallback: defaults.uiLanguage, options: ['zh-CN', 'en'] },
    { label: '界面主题 / UI theme', fallback: defaults.uiTheme, options: ['dark', 'light'] },
    knownWorkspaces.length
      ? workspaceSelector.question
      : { label: '工作区路径 / Workspace path', fallback: defaults.workspaceDir, validate: (value) => { try { return path.resolve(value) ? undefined : 'Invalid workspace.'; } catch { return 'Invalid workspace.'; } } },
    {
      label: (previous) => {
        const selected = selectedWorkspace(workspaceItems, previous[2] || '');
        return isAddWorkspaceSelection(selected)
          ? '新的工作区路径 / New workspace path'
          : '工作区路径确认 / Workspace path confirmation';
      },
      fallback: '',
      validate: (value, previous) => {
        const selected = selectedWorkspace(workspaceItems, previous[2] || '');
        if (!isAddWorkspaceSelection(selected)) return undefined;
        return value.trim() && path.resolve(value) ? undefined : 'Workspace path is required.';
      },
    },
    { label: '监听地址 / Host', fallback: defaults.host },
    { label: '端口 / Port', fallback: String(defaults.port), validate: (value) => { const port = Number(value); return Number.isInteger(port) && port >= 0 && port <= 65535 ? undefined : 'Port must be 0-65535.'; } },
    { label: '公网 HTTPS URL / Public URL (optional)', fallback: defaults.publicBaseUrl },
    { label: '最大输出字符 / Max output', fallback: String(defaults.maxOutputChars) },
    { label: '命令超时秒数 / Timeout', fallback: String(defaults.commandTimeoutSec) },
    { label: '保存并启动 / Save and start?', fallback: 'yes', options: ['yes', 'no'] },
  ];

  const submit = async (answers: string[]) => {
    if (pendingConflict) {
      const policy = answers[0].toLowerCase();
      try {
        if (policy === 'kill') await terminatePortOwner(pendingConflict.candidate.port);
        else if (policy === 'next') pendingConflict.candidate.port = await findAvailablePort(pendingConflict.candidate.host, pendingConflict.candidate.port);
        else { setPendingConflict(undefined); setFeedback(['端口冲突处理已取消 / Port conflict handling cancelled']); setAttempt((value) => value + 1); return; }
        onComplete(pendingConflict.candidate);
      } catch (error) {
        setPendingConflict(undefined);
        setFeedback(['端口处理失败 / Port handling failed', error instanceof Error ? error.message : String(error)]);
        setAttempt((value) => value + 1);
      }
      return;
    }
    if (!['yes', 'y'].includes(answers[9].toLowerCase())) { setAttempt((value) => value + 1); return; }
    const candidate: MyTerminalSettings = {
      ...defaults,
      uiLanguage: answers[0] as MyTerminalSettings['uiLanguage'],
      uiTheme: answers[1] as MyTerminalSettings['uiTheme'],
      workspaceDir: (() => {
        const selected = selectedWorkspace(workspaceItems, answers[2]);
        if (isAddWorkspaceSelection(selected)) return answers[3];
        return selected?.workspaceDir || resolveWorkspaceInput(answers[2], knownWorkspaces);
      })(),
      host: answers[4],
      port: integer(answers[5], defaults.port),
      publicBaseUrl: answers[6].replace(/\/$/, ''),
      maxOutputChars: integer(answers[7], defaults.maxOutputChars),
      commandTimeoutSec: integer(answers[8], defaults.commandTimeoutSec),
    };
    const errors = validateSettings(candidate);
    if (errors.length) {
      setFeedback(['设置无效 / Invalid settings', ...errors]);
      setAttempt((value) => value + 1);
      return;
    }
    const feasibility = await validateSettingsFeasibility(candidate);
    const portConflict = feasibility.find((error) => error.includes('already in use'));
    if (portConflict) {
      setPendingConflict({ candidate, message: portConflict });
      setFeedback(['端口被其他程序占用 / Port occupied by another program', portConflict]);
      setAttempt((value) => value + 1);
      return;
    }
    if (feasibility.length) { setFeedback(['设置不可用 / Settings are not feasible', ...feasibility]); setAttempt((value) => value + 1); return; }
    onComplete(candidate);
  };

  return (
    <box width={width} height={height} backgroundColor={theme.background}>
      <box position="absolute" left={Math.max(0, Math.floor((width - 9) / 2))} top={0}>
        <Mascot mood="happy" theme={theme} />
      </box>
      <FormDialog key={attempt} questions={questions} preamble={feedback} theme={theme} width={width} height={height} zh={defaults.uiLanguage === 'zh-CN'} mouseEnabled={mouseEnabled} onComplete={submit} onCancel={onCancel} />
    </box>
  );
}
