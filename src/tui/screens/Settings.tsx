import type { MyTerminalRuntime } from '../../server.js';
import { maskCredential } from '../../config.js';
import type { Theme } from '../state.js';
import type { UpdateStatus } from '../../update.js';
import { Heading, Line } from './shared.js';
import { runtimeSettingsSnapshot } from '../../runtime-settings.js';

export function Settings({ runtime, theme, zh, reveal, update }: { runtime: MyTerminalRuntime; theme: Theme; zh: boolean; reveal: boolean; update: UpdateStatus }) {
  const config = runtimeSettingsSnapshot(runtime);
  const passiveStatus = runtime.passiveLockStatus();
  const passiveEnabled = config.passiveLockEnabled;
  const permissionMissing = /waiting_accessibility_permission|requesting_accessibility_permission|permission_window_visible/.test(passiveStatus.state);
  return (
    <box flexDirection="column" width="100%" padding={1} gap={0}>
      <Heading theme={theme}>{zh ? '运行设置' : 'Runtime settings'}</Heading>
      <Line color={theme.text}>{`${zh ? '界面语言' : 'Language'}: ${config.uiLanguage}`}</Line>
      <Line color={theme.text}>{`${zh ? '界面主题' : 'Theme'}: ${config.uiTheme}`}</Line>
      <Line color={theme.text}>{`${zh ? '配置文件' : 'Settings file'}: ${runtime.config.settingsPath}`}</Line>
      <Line color={theme.text}>{`${zh ? '工作区' : 'Workspace'}: ${config.workspaceDir}`}</Line>
      <Line color={theme.text}>{`${zh ? '监听地址' : 'Listen'}: ${config.host}:${config.port}`}</Line>
      <Line color={theme.text}>{`${zh ? '公网 URL' : 'Public URL'}: ${config.publicBaseUrl}`}</Line>
      <Line color={theme.text}>{`${zh ? '最大输出' : 'Max output'}: ${config.maxOutputChars}`}</Line>
      <Line color={theme.text}>{`${zh ? '命令超时' : 'Timeout'}: ${config.commandTimeoutSec}s`}</Line>
      <Line color={theme.text}>{`${zh ? '长任务 Harness' : 'Long-task harness'}: ${config.actionsContinuationMode}`}</Line>
      <Line color={theme.text}>{`${zh ? '非阻塞任务' : 'Non-blocking tasks'}: ${config.nonBlockingTasksEnabled ? (zh ? '开启' : 'on') : (zh ? '关闭' : 'off')}`}</Line>
      <Line color={process.platform === 'darwin' ? theme.text : theme.muted}>{`${zh ? 'macOS 被动锁屏' : 'macOS passive lock'}: ${process.platform === 'darwin' ? (passiveEnabled ? passiveStatus.state : (zh ? '关闭' : 'off')) : (zh ? '仅支持 macOS' : 'macOS only')}`}</Line>
      {process.platform === 'darwin' && permissionMissing ? <Line color={theme.warn}>{zh ? '缺少无障碍权限：请在 系统设置 → 隐私与安全性 → 无障碍 中，为启动 MyTerminal 的终端应用授予权限。' : 'Accessibility permission is missing. Grant it to the terminal app that launched MyTerminal.'}</Line> : null}
      <Line color={update.restartRequired || update.updateAvailable ? theme.warn : update.error ? theme.bad : theme.good}>{update.checking ? (zh ? '更新：检查中…' : 'Update: checking…') : update.restartRequired ? `${zh ? '更新已安装，等待逐个重启' : 'Update installed; restart members one by one'}${update.runningClusterVersions?.length ? ` · ${zh ? '运行版本' : 'running'}: ${update.runningClusterVersions.join(', ')}` : ''}` : update.updateAvailable ? `${zh ? '可更新' : 'Update available'}: ${update.currentVersion} → ${update.latestVersion} · U ${zh ? '一键更新' : 'install'}` : update.error ? `${zh ? '更新检查失败' : 'Update check failed'}: ${update.error}` : `${zh ? '版本' : 'Version'}: ${update.currentVersion} · ${zh ? '已是最新' : 'up to date'}`}</Line>
      <text> </text>
      <Heading theme={theme}>{zh ? '连接凭据' : 'Connection credentials'}</Heading>
      <text fg={theme.text} wrapMode="none">{`Apps connector: ${reveal ? config.connectorKey : '••••••••'}`}</text>
      <text fg={theme.text} wrapMode="none">{`Actions token: ${reveal ? config.actionsToken : maskCredential(config.actionsToken)}`}</text>
      <Line color={theme.warn}>{zh ? '轮换凭据会使现有 Apps 与 Actions 连接失效。' : 'Rotating credentials disconnects existing Apps and Actions clients.'}</Line>
    </box>
  );
}
