import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { MyTerminalRuntime } from '../server.js';
import type { Theme } from './state.js';

type Props = {
  runtime: MyTerminalRuntime;
  theme: Theme;
  zh: boolean;
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
    const message = this.props.zh
      ? '界面发生严重错误。已停止渲染损坏页面。按 q 或 Esc 安全退出。'
      : 'The interface encountered a fatal error. The damaged screen was stopped. Press q or Esc to exit safely.';
    return (
      <box flexGrow={1} flexDirection="column" padding={2} backgroundColor={this.props.theme.background}>
        <text fg={this.props.theme.bad}>{this.props.zh ? '严重错误' : 'Fatal error'}</text>
        <text fg={this.props.theme.text}>{message}</text>
        <text fg={this.props.theme.muted}>{error.message}</text>
      </box>
    );
  }
}
