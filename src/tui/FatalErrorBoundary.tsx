import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { MyTerminalRuntime } from '../server.js';
import type { Theme } from './state.js';
import { Mascot } from './components/Mascot.js';
import { I18nContext } from './copy/context.js';

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
          if (!i18n) return null;
          const t = i18n.t;
          const message = t('The interface encountered a fatal error. The damaged screen was stopped. Press q or Esc to exit safely.', '界面发生严重错误。已停止渲染损坏页面。按 q 或 Esc 安全退出。');
          return (
            <box flexGrow={1} flexDirection="column" padding={2} backgroundColor={this.props.theme.background} alignItems="center">
              <Mascot mood="sad" theme={this.props.theme} animated={false} />
              <text fg={this.props.theme.bad}><b>{t('Fatal error', '严重错误')}</b></text>
              <text fg={this.props.theme.text}>{message}</text>
              <text fg={this.props.theme.muted}>{error.message}</text>
            </box>
          );
        }}
      </I18nContext.Consumer>
    );
  }
}
