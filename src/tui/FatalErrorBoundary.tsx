import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { MyTerminalRuntime } from '../server.js';
import type { Theme } from './state.js';
import { Mascot } from './components/Mascot.js';
import { DevInvariantError, I18nContext } from './copy/context.js';
import { i18nFor } from './copy/i18n.js';

type Props = {
  runtime: MyTerminalRuntime;
  theme: Theme;
  onFatal: (error: Error) => void;
  children: ReactNode;
};

type State = { error?: Error };

export class FatalErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.runtime.log(`TUI render failure: ${error.message}\n${info.componentStack || ''}`, 'error');
    this.props.onFatal(error);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <I18nContext.Consumer>
        {(i18n) => {
          // 致命错误屏是最后一道兜底，**任何情况下都必须渲染**（main 基线行为）。
          // 缺 Provider 时从 runtime 配置推导语言兜底，绝不 return null——
          // 白屏会吞掉用户唯一的「按 q/Esc 安全退出」指引。
          const t = (i18n ?? i18nFor(this.props.runtime.config.uiLanguage)).t;
          const message = t('The interface encountered a fatal error. The damaged screen was stopped. Press q or Esc to exit safely.', '界面发生严重错误。已停止渲染损坏页面。按 q 或 Esc 安全退出。');
          return (
            <box flexGrow={1} flexDirection="column" padding={2} backgroundColor={this.props.theme.background} alignItems="center">
              <Mascot mood="sad" theme={this.props.theme} animated={false} />
              <text fg={this.props.theme.bad}><b>{t('Fatal error', '严重错误')}</b></text>
              <text fg={this.props.theme.text}>{message}</text>
              {/* 开发不变量错误的 message 是开发指令，不是 UI 文案（AI_RULES）：
                  只给用户向兜底提示，原始指令已由 componentDidCatch 写入日志。 */}
              <text fg={this.props.theme.muted}>
                {error instanceof DevInvariantError || error.name === 'DevInvariantError'
                  ? t('Internal interface error. Details were written to the log.', '界面内部错误。详细信息已写入日志。')
                  : error.message}
              </text>
            </box>
          );
        }}
      </I18nContext.Consumer>
    );
  }
}
