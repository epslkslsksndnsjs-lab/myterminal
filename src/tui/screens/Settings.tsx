/**
 * Settings — 设置页（ADR-0004 决策 7）。
 * 卡片式布局：运行设置 / macOS 被动锁屏 / L3 模型（D-8 通道2，#95）/ 连接凭据+更新。
 * L2 精确层：所有语义不变，仅视觉重排。
 */
import type { ReactNode } from 'react';
import type { MyTerminalRuntime } from '../../server.js';
import { maskCredential } from '../../config.js';
import type { Theme } from '../state.js';
import { hiddenAppsUrl } from '../state.js';
import type { UpdateStatus } from '../../update.js';
import { Heading, Line } from './shared.js';
import { runtimeSettingsSnapshot } from '../../runtime-settings.js';
import { useI18n } from '../copy/context.js';
import type { L3HealthSnapshot, L3HealthStatus } from '../../l3/warmup.js';

function SettingsCard({ title, theme, children }: { title: string; theme: Theme; children: ReactNode }) {
  return (
    <box flexDirection="column" backgroundColor={theme.panel} padding={1} marginBottom={1}>
      <text fg={theme.accent}><b>{title}</b></text>
      {children}
    </box>
  );
}

/** D-8 通道2（#95 W3-03）：TUI 状态页 L3 就绪状态 presenter（纯函数，issue-89 同款可测模式）。 */
export type L3StatusTone = 'text' | 'good' | 'warn' | 'bad' | 'muted';
export interface L3StatusLine { text: string; tone: L3StatusTone }

const L3_STATUS_LABELS: Record<L3HealthStatus, { en: string; zh: string; tone: L3StatusTone }> = {
  ready: { en: 'Ready', zh: '就绪', tone: 'good' },
  loading: { en: 'Loading', zh: '预热中', tone: 'text' },
  missing: { en: 'Model missing', zh: '模型缺失', tone: 'warn' },
  failed: { en: 'Failed', zh: '预热失败', tone: 'bad' },
};

export function l3StatusView(l3: L3HealthSnapshot | undefined, t: (en: string, zh: string) => string): L3StatusLine[] {
  if (!l3) return [{ text: t('L3 model: off', 'L3 模型：未启用'), tone: 'muted' }];
  const label = L3_STATUS_LABELS[l3.status];
  const lines: L3StatusLine[] = [{ text: `${t('Status', '状态')}: ${t(label.en, label.zh)}`, tone: label.tone }];
  lines.push({ text: `${t('Model', '模型')}: ${l3.modelId}`, tone: 'text' });
  if (l3.status === 'ready' && l3.warmLatencyMs !== undefined) {
    lines.push({ text: `${t('Warmup', '预热')}: ${l3.warmLatencyMs}ms`, tone: 'text' });
  }
  if (l3.status === 'missing') {
    // D-7：缺失时指向 fetch 命令（与启动日志同款提示）
    lines.push({ text: t('L3 model missing. Run `myterminal l3-model fetch` to enable L3.', 'L3 模型缺失：运行 `myterminal l3-model fetch` 下载并启用 L3。'), tone: 'warn' });
  }
  return lines;
}

export function Settings({ runtime, theme, reveal, update }: {
  runtime: MyTerminalRuntime;
  theme: Theme;
  reveal: boolean;
  update: UpdateStatus;
}) {
  const { t } = useI18n();
  const config = runtimeSettingsSnapshot(runtime);
  const passiveStatus = runtime.passiveLockStatus();
  const l3 = runtime.l3Health();
  const passiveEnabled = config.passiveLockEnabled;
  const permissionMissing = /waiting_accessibility_permission|requesting_accessibility_permission|permission_window_visible/.test(passiveStatus.state);

  return (
    <box flexDirection="column" width="100%" padding={1} gap={0}>
      <Heading theme={theme}>{t('Runtime settings', '运行设置')}</Heading>

      {/* 组 1：运行设置 */}
      <SettingsCard title={t('Runtime', '运行设置')} theme={theme}>
        <Line color={theme.text}>{`${t('Language', '界面语言')}: ${config.uiLanguage}`}</Line>
        <Line color={theme.text}>{`${t('Theme', '界面主题')}: ${config.uiTheme}`}</Line>
        <Line color={theme.text}>{`${t('Settings file', '配置文件')}: ${runtime.config.settingsPath}`}</Line>
        <Line color={theme.text}>{`${t('Workspace', '工作区')}: ${config.workspaceDir}`}</Line>
        <Line color={theme.text}>{`${t('Listen', '监听地址')}: ${config.host}:${config.port}`}</Line>
        <Line color={theme.text}>{`${t('Public URL', '公网 URL')}: ${config.publicBaseUrl}`}</Line>
        <Line color={theme.text}>{`${t('Max output', '最大输出')}: ${config.maxOutputChars}`}</Line>
        <Line color={theme.text}>{`${t('Timeout', '命令超时')}: ${config.commandTimeoutSec}s`}</Line>
        <Line color={theme.text}>{`${t('Long-task harness', '长任务 Harness')}: ${config.actionsContinuationMode}`}</Line>
        <Line color={theme.text}>{`${t('Non-blocking tasks', '非阻塞任务')}: ${config.nonBlockingTasksEnabled ? (t('on', '开启')) : (t('off', '关闭'))}`}</Line>
      </SettingsCard>

      {/* 组 2：macOS 被动锁屏 */}
      <SettingsCard title={t('macOS passive lock', 'macOS 被动锁屏')} theme={theme}>
        <Line color={process.platform === 'darwin' ? theme.text : theme.muted}>
          {process.platform === 'darwin'
            ? (passiveEnabled ? passiveStatus.state : (t('off', '关闭')))
            : (t('macOS only', '仅支持 macOS'))}
        </Line>
        {process.platform === 'darwin' && permissionMissing ? (
          <Line color={theme.warn}>
            {t('Accessibility permission is missing. Grant it to the terminal app that launched MyTerminal.', '缺少无障碍权限：请在 系统设置 → 隐私与安全性 → 无障碍 中，为启动 MyTerminal 的终端应用授予权限。')}
          </Line>
        ) : null}
      </SettingsCard>

      {/* 组 3：L3 模型（D-8 通道2：#95 — 就绪状态对人可见） */}
      <SettingsCard title={t('L3 model', 'L3 模型')} theme={theme}>
        {l3StatusView(l3, t).map((line, index) => (
          <Line key={`l3-${index}`} color={theme[line.tone]}>{line.text}</Line>
        ))}
      </SettingsCard>

      {/* 组 4：连接凭据 + 更新 */}
      <SettingsCard title={t('Credentials & update', '连接凭据与更新')} theme={theme}>
        <text fg={theme.text} wrapMode="none">{`Apps MCP URL: ${hiddenAppsUrl(runtime, reveal)}`}</text>
        <text fg={theme.text} wrapMode="none">{`Actions OpenAPI: ${runtime.openApiUrl}`}</text>
        <text fg={theme.text} wrapMode="none">{`Apps connector: ${reveal ? config.connectorKey : '••••••••'}`}</text>
        <text fg={theme.text} wrapMode="none">{`Actions token: ${reveal ? config.actionsToken : maskCredential(config.actionsToken)}`}</text>
        <Line color={theme.warn}>{t('Rotating credentials disconnects existing Apps and Actions clients.', '轮换凭据会使现有 Apps 与 Actions 连接失效。')}</Line>
        <text> </text>
        <Line
          color={update.restartRequired || update.updateAvailable ? theme.warn : update.error ? theme.bad : theme.good}
        >
          {update.checking
            ? (t('Update: checking…', '更新：检查中…'))
            : update.restartRequired
              ? `${t('Update installed; restart members one by one', '更新已安装，等待逐个重启')}${update.runningClusterVersions?.length ? ` · ${t('running', '运行版本')}: ${update.runningClusterVersions.join(', ')}` : ''}`
              : update.updateAvailable
                ? `${t('Update available', '可更新')}: ${update.currentVersion} → ${update.latestVersion} · U ${t('install', '一键更新')}`
                : update.error
                  ? `${t('Update check failed', '更新检查失败')}: ${update.error}`
                  : `${t('Version', '版本')}: ${update.currentVersion} · ${t('up to date', '已是最新')}`}
        </Line>
      </SettingsCard>
    </box>
  );
}
