import { type ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { conversationGroups, logicalSessionGroups } from '../tui-model.js';
import { copyToHostClipboard, themeFor, TABS, type Ask, type Detail, type FormQuestion, type TuiController } from './state.js';
import { useAppKeymap } from './keymap.js';
import { nextCredentialVisibility } from './credential-visibility.js';
import { TopBar } from './components/chrome/TopBar.js';
import { BottomNav } from './components/chrome/BottomNav.js';
import { StatusLine } from './components/chrome/StatusLine.js';
import { InputBar } from './components/InputBar.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { FatalErrorBoundary } from './FatalErrorBoundary.js';
import { FormDialog } from './components/FormDialog.js';
import { routeCommand, commandCompletions, type CommandAction } from './model/command-router.js';
import { copyFor } from './copy/index.js';
import { Home } from './screens/Home.js';
import { Sessions, SessionDetail } from './screens/Sessions.js';
import { Messages, ConversationDetail } from './screens/Messages.js';
import { Timeline } from './screens/Timeline.js';
import { DiffScreen } from './screens/Diff.js';
import { Extensions } from './screens/Extensions.js';
import { Settings } from './screens/Settings.js';
import { Logs } from './screens/Logs.js';

type FormState = {
  id: number;
  questions: FormQuestion[];
  preamble: string[];
  resolve: (answers: string[] | undefined) => void;
};

export function App({ controller, onExit }: { controller: TuiController; onExit: () => void }) {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [tab, setTab] = useState(0);
  const [selected, setSelected] = useState<number[]>(Array(TABS.length).fill(0));
  const [detail, setDetail] = useState<Detail>();
  const [revealCredentials, setRevealCredentials] = useState(false);
  const credentialRevealDeadline = useRef(0);
  const [showAudit, setShowAudit] = useState(true);
  const [logPage, setLogPage] = useState(0);
  const [logAnchorAt, setLogAnchorAt] = useState<string>();
  const [form, setForm] = useState<FormState>();
  const [notice, setNotice] = useState<string>();
  const [fatalError, setFatalError] = useState<Error>();
  const [, setRevision] = useState(0);
  const [inputEditing, setInputEditing] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const exiting = useRef(false);
  const nextFormId = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const snapshot = controller.snapshot();
  const { runtime, state, diff, logs, update } = snapshot;
  const zh = runtime.config.uiLanguage === 'zh-CN';
  const theme = themeFor(runtime.config.uiTheme);
  const copy = copyFor(zh);
  const pending = state.sessions.filter((session) => !['completed', 'cancelled'].includes(session.phase) && session.presence !== 'claimed').length;

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice((current) => current === message ? undefined : current), 2200);
  }, []);

  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  // 双速 tick（ADR-0004 决策 12）：快 tick 150ms 只做 revision 比对；慢 tick 1s 维持 reminders
  useEffect(() => {
    let renderedRevision = controller.renderRevision();
    const fastTimer = setInterval(() => {
      const nextRevision = controller.renderRevision();
      if (nextRevision !== renderedRevision) {
        renderedRevision = nextRevision;
        refresh();
      }
    }, 150);
    const slowTimer = setInterval(() => {
      controller.tickReminders();
    }, 1000);
    return () => { clearInterval(fastTimer); clearInterval(slowTimer); };
  }, [controller, refresh]);

  const ask: Ask = useCallback((questions, preamble = []) => new Promise((resolve) => {
    // Consecutive forms can be scheduled in the same React batch (Settings
    // first asks which fields to edit, then immediately asks their values).
    // A unique key forces a fresh FormDialog so option labels, descriptions,
    // selected index, answers, and renderables cannot leak from the prior form.
    nextFormId.current += 1;
    setForm({ id: nextFormId.current, questions, preamble, resolve });
  }), []);

  const completeForm = useCallback((answers: string[]) => {
    const resolve = form?.resolve;
    setForm(undefined);
    resolve?.(answers);
  }, [form]);

  const cancelForm = useCallback(() => {
    const resolve = form?.resolve;
    setForm(undefined);
    resolve?.(undefined);
  }, [form]);

  const runAction = useCallback(async (action: () => Promise<void>) => {
    try { await action(); }
    catch (error) { controller.runtime.log(error instanceof Error ? error.message : String(error), 'error'); }
    refresh();
  }, [controller, refresh]);

  const switchTab = useCallback((index: number) => { setRevealCredentials(false); setDetail(undefined); if (index !== 7) { setLogPage(0); setLogAnchorAt(undefined); } setTab(index); }, []);
  const nextTab = useCallback((delta: number) => { setRevealCredentials(false); setDetail(undefined); setTab((value) => (value + TABS.length + delta) % TABS.length); }, []);
  const back = useCallback(() => { setRevealCredentials(false); setDetail(undefined); }, []);
  const quit = useCallback(() => {
    if (exiting.current) return;
    exiting.current = true;
    onExit();
  }, [onExit]);

  const groups = logicalSessionGroups(state.sessions);
  const conversations = conversationGroups(state.messages);
  const itemCount = tab === 1 ? groups.length : tab === 2 ? conversations.length : tab === 5 ? state.extensions.length : 0;
  const activeSelection = Math.max(0, Math.min(Math.max(0, itemCount - 1), selected[tab] || 0));

  const moveSelection = useCallback((delta: number) => {
    setSelected((values) => {
      const next = [...values];
      const count = tab === 1 ? logicalSessionGroups(controller.runtime.store.listSessions()).length
        : tab === 2 ? conversationGroups(controller.runtime.store.listMessages(1000)).length
          : tab === 5 ? controller.runtime.store.listExtensions().length : 0;
      next[tab] = Math.max(0, Math.min(Math.max(0, count - 1), (next[tab] || 0) + delta));
      return next;
    });
  }, [controller, tab]);

  const selectItem = useCallback((index: number) => setSelected((values) => { const next = [...values]; next[tab] = index; return next; }), [tab]);

  const selectedTargetId = tab === 1 ? groups[activeSelection]?.id : tab === 2 ? conversations[activeSelection]?.id : tab === 5 ? state.extensions[activeSelection]?.name : undefined;
  useEffect(() => {
    if (detail) return;
    if (!selectedTargetId) return;
    const prefix = tab === 1 ? 'session' : tab === 2 ? 'conversation' : 'extension';
    scrollRef.current?.scrollChildIntoView(`${prefix}-${selectedTargetId}`);
  }, [tab, detail, activeSelection, selectedTargetId]);

  const open = useCallback(() => {
    if (tab === 1 && groups[activeSelection]) setDetail({ kind: 'session', id: groups[activeSelection].id });
    if (tab === 2 && conversations[activeSelection]) setDetail({ kind: 'conversation', id: conversations[activeSelection].id });
  }, [tab, groups, conversations, activeSelection]);

  const createSessionAction = useCallback(() => runAction(() => controller.createSession(ask)), [runAction, controller, ask]);
  const sessionAction = useCallback(() => runAction(async () => {
    const group = logicalSessionGroups(controller.runtime.store.listSessions())[selected[1] || 0];
    if (!group) return;
    const nextDetail = await controller.sessionAction([...group.sessions, ...group.children], ask);
    if (nextDetail) setDetail(nextDetail);
  }), [runAction, controller, selected, ask]);
  const sendMessageAction = useCallback(() => runAction(() => controller.sendMessage(ask)), [runAction, controller, ask]);
  const refreshDiffAction = useCallback(() => runAction(() => controller.refreshDiff()), [runAction, controller]);
  const addExtensionAction = useCallback(() => runAction(() => controller.addExtension(ask)), [runAction, controller, ask]);
  const removeExtensionAction = useCallback(() => runAction(() => controller.removeExtension(controller.runtime.store.listExtensions()[selected[5] || 0]?.name, ask)), [runAction, controller, selected, ask]);
  const configureAction = useCallback(() => runAction(() => controller.editSettings(ask)), [runAction, controller, ask]);
  const rotateCredentialsAction = useCallback(() => runAction(async () => { await controller.rotateCredentials(ask); }), [runAction, controller, ask]);
  const updateApplicationAction = useCallback(() => runAction(() => controller.updateApplication(ask)), [runAction, controller, ask]);
  const toggleAudit = useCallback(() => setShowAudit((value) => !value), []);

  // ─── InputBar 命令路由 ───
  const handleInputSubmit = useCallback((text: string) => {
    const action: CommandAction = routeCommand(text);
    if (action.kind === 'navigate') {
      switchTab(action.tab);
    } else if (action.kind === 'pageAction') {
      if (action.action === 'createSession') createSessionAction();
      else if (action.action === 'sendMessage') sendMessageAction();
      else if (action.action === 'refreshDiff') refreshDiffAction();
    } else if (action.kind === 'help') {
      setShowHelp(true);
    } else if (action.kind === 'message') {
      // 找最近活跃 claimed 非终态 session
      const eligible = controller.runtime.store.listSessions()
        .filter((session) => !['completed', 'cancelled'].includes(session.phase))
        .filter((session) => session.presence === 'claimed')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (eligible.length === 0) {
        showNotice(zh
          ? '没有可接收消息的 session。先在会话页创建一个。'
          : 'No session can receive messages. Create one on the Sessions page.');
        return;
      }
      const target = eligible[0];
      controller.runtime.store.sendUserMessage(target.id, action.body);
      showNotice(zh ? `已发给 ${target.name}` : `Sent to ${target.name}`);
    } else if (action.kind === 'unknown') {
      showNotice(zh
        ? `未知命令 ${action.input}${action.suggestion ? `，是指 ${action.suggestion} 吗？` : '。输入 /help 看全部命令。'}`
        : `Unknown command ${action.input}${action.suggestion ? `. Did you mean ${action.suggestion}?` : '. Type /help for all commands.'}`);
    }
  }, [switchTab, createSessionAction, sendMessageAction, refreshDiffAction, controller, showNotice, zh]);

  const handleStartCommand = useCallback(() => {
    setInputEditing(true);
  }, []);

  const pageActions = useMemo(() => ({
    enabled: !form,
    tab,
    detail,
    inputEditing,
    switchTab,
    nextTab,
    back,
    quit,
    moveSelection,
    open,
    createSession: createSessionAction,
    sessionAction,
    sendMessage: sendMessageAction,
    refreshDiff: refreshDiffAction,
    addExtension: addExtensionAction,
    removeExtension: removeExtensionAction,
    configure: configureAction,
    rotateCredentials: rotateCredentialsAction,
    updateApplication: updateApplicationAction,
    toggleAudit,
    enterInput: handleStartCommand,
    openHelp: () => setShowHelp(true),
  }), [form, tab, detail, inputEditing, switchTab, nextTab, back, quit, moveSelection, open, createSessionAction, sessionAction, sendMessageAction, refreshDiffAction, addExtensionAction, removeExtensionAction, configureAction, rotateCredentialsAction, updateApplicationAction, toggleAudit, handleStartCommand]);
  useAppKeymap(pageActions);

  useEffect(() => {
    if (!revealCredentials) return;
    const timer = setInterval(() => {
      if (performance.now() >= credentialRevealDeadline.current) setRevealCredentials(false);
    }, 50);
    return () => clearInterval(timer);
  }, [revealCredentials]);

  useKeyboard((event) => {
    if (fatalError && (event.name === 'q' || event.name === 'escape')) { void quit(); return; }
    if (!form && !detail && tab === 7 && event.eventType !== 'release') {
      if (event.name === 'pagedown') {
        setLogAnchorAt((value) => value || new Date().toISOString());
        setLogPage((value) => value + 1);
        return;
      }
      if (event.name === 'pageup') {
        setLogPage((value) => {
          const next = Math.max(0, value - 1);
          if (next === 0) setLogAnchorAt(undefined);
          return next;
        });
        return;
      }
    }
    const eligible = !form && !detail && [0, 6].includes(tab);
    if (eligible && event.eventType !== 'release' && event.name?.toLowerCase() === 'v') {
      credentialRevealDeadline.current = performance.now() + 450;
    }
    setRevealCredentials((current) => nextCredentialVisibility(
      current,
      { name: event.name, eventType: event.eventType },
      eligible,
    ));
  }, { release: true });

  const copySelection = useCallback(() => {
    if (!renderer.hasSelection) return;
    const selection = renderer.getSelection();
    const text = selection?.getSelectedText().trimEnd();
    if (!text) return;
    renderer.copyToClipboardOSC52(text);
    void copyToHostClipboard(text);
    renderer.clearSelection();
    showNotice(zh ? '已复制所选文字' : 'Selection copied');
  }, [renderer, showNotice, zh]);

  const content = detail?.kind === 'session' ? <SessionDetail runtime={runtime} groupId={detail.id} theme={theme} zh={zh} />
    : detail?.kind === 'conversation' ? <ConversationDetail state={state} id={detail.id} theme={theme} zh={zh} />
      : tab === 0 ? <Home runtime={runtime} state={state} snapshot={snapshot} theme={theme} zh={zh} copy={copy} />
        : tab === 1 ? <Sessions state={state} selected={activeSelection} theme={theme} zh={zh} onSelect={selectItem} />
          : tab === 2 ? <Messages state={state} selected={activeSelection} theme={theme} zh={zh} onSelect={selectItem} />
            : tab === 3 ? <Timeline theme={theme} zh={zh} />
              : tab === 4 ? <DiffScreen snapshot={diff} theme={theme} zh={zh} />
                : tab === 5 ? <Extensions state={state} selected={activeSelection} theme={theme} zh={zh} onSelect={selectItem} />
                  : tab === 6 ? <Settings runtime={runtime} theme={theme} zh={zh} reveal={revealCredentials} update={update} />
                    : <Logs runtime={runtime} logs={logs} theme={theme} zh={zh} showAudit={showAudit} page={logPage} anchorAt={logAnchorAt} />;

  const scrollKey = `${tab}-${detail?.kind || 'page'}-${detail?.id || ''}-r${Number(revealCredentials)}`;
  return (
    <FatalErrorBoundary runtime={runtime} theme={theme} zh={zh} onFatal={setFatalError}>
    <box width={width} height={height} flexDirection="column" backgroundColor={theme.background} onMouseUp={copySelection}>
      <TopBar runtime={runtime} theme={theme} pending={pending} zh={zh} />
      <BottomNav active={tab} theme={theme} zh={zh} onSelect={switchTab} />
      <box height={1} flexShrink={0} backgroundColor={theme.background}><text fg={theme.border}>{'─'.repeat(Math.max(1, width))}</text></box>
      <scrollbox
        key={scrollKey}
        ref={scrollRef}
        flexGrow={1}
        minHeight={0}
        focused={!form && !inputEditing}
        viewportCulling
        stickyScroll={detail?.kind === 'conversation'}
        stickyStart={detail?.kind === 'conversation' ? 'bottom' : undefined}
        verticalScrollbarOptions={{ visible: true }}
      >
        {content}
      </scrollbox>
      <InputBar
        theme={theme}
        copy={copy}
        editing={inputEditing}
        onEditingChange={setInputEditing}
        onSubmitText={handleInputSubmit}
        completions={commandCompletions}
      />
      <StatusLine tab={tab} detail={detail} theme={theme} zh={zh} mouseEnabled={renderer.useMouse} notice={notice} inputEditing={inputEditing} />
      {form ? <FormDialog key={form.id} questions={form.questions} preamble={form.preamble} theme={theme} width={width} height={height} zh={zh} mouseEnabled={renderer.useMouse} onComplete={completeForm} onCancel={cancelForm} /> : null}
      {showHelp ? <HelpOverlay theme={theme} zh={zh} width={width} height={height} onClose={() => setShowHelp(false)} /> : null}
    </box>
    </FatalErrorBoundary>
  );
}
