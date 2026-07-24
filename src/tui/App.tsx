import { type ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { conversationGroups, logicalSessionGroups } from '../tui-model.js';
import { copyToHostClipboard, themeFor, TABS, type Ask, type Detail, type FormQuestion, type TuiController } from './state.js';
import { useAppKeymap } from './keymap.js';
import { nextCredentialVisibility } from './credential-visibility.js';
import { Header } from './components/Header.js';
import { FatalErrorBoundary } from './FatalErrorBoundary.js';
import { TabBar } from './components/TabBar.js';
import { Footer } from './components/Footer.js';
import { FormDialog } from './components/FormDialog.js';
import { Overview } from './screens/Overview.js';
import { Sessions, SessionDetail } from './screens/Sessions.js';
import { Messages, ConversationDetail } from './screens/Messages.js';
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
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const exiting = useRef(false);
  const nextFormId = useRef(0);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const snapshot = controller.snapshot();
  const { runtime, state, diff, logs, update } = snapshot;
  const zh = runtime.config.uiLanguage === 'zh-CN';
  const theme = themeFor(runtime.config.uiTheme);
  const pending = state.sessions.filter((session) => !['completed', 'cancelled'].includes(session.phase) && session.presence !== 'claimed').length;

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice((current) => current === message ? undefined : current), 2200);
  }, []);

  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  useEffect(() => {
    let renderedRevision = controller.renderRevision();
    const timer = setInterval(() => {
      controller.tickReminders();
      const nextRevision = controller.renderRevision();
      if (nextRevision !== renderedRevision) {
        renderedRevision = nextRevision;
        refresh();
      }
    }, 1000);
    return () => clearInterval(timer);
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

  const switchTab = useCallback((index: number) => { setRevealCredentials(false); setDetail(undefined); if (index !== 6) { setLogPage(0); setLogAnchorAt(undefined); } setTab(index); }, []);
  const nextTab = useCallback((delta: number) => { setRevealCredentials(false); setDetail(undefined); setTab((value) => (value + TABS.length + delta) % TABS.length); }, []);
  const back = useCallback(() => { setRevealCredentials(false); setDetail(undefined); }, []);
  const quit = useCallback(() => {
    if (exiting.current) return;
    exiting.current = true;
    onExit();
  }, [onExit]);

  const groups = logicalSessionGroups(state.sessions);
  const conversations = conversationGroups(state.messages);
  const itemCount = tab === 1 ? groups.length : tab === 2 ? conversations.length : tab === 4 ? state.extensions.length : 0;
  const activeSelection = Math.max(0, Math.min(Math.max(0, itemCount - 1), selected[tab] || 0));

  const moveSelection = useCallback((delta: number) => {
    setSelected((values) => {
      const next = [...values];
      const count = tab === 1 ? logicalSessionGroups(controller.runtime.store.listSessions()).length
        : tab === 2 ? conversationGroups(controller.runtime.store.listMessages(1000)).length
          : tab === 4 ? controller.runtime.store.listExtensions().length : 0;
      next[tab] = Math.max(0, Math.min(Math.max(0, count - 1), (next[tab] || 0) + delta));
      return next;
    });
  }, [controller, tab]);

  const selectItem = useCallback((index: number) => setSelected((values) => { const next = [...values]; next[tab] = index; return next; }), [tab]);

  const selectedTargetId = tab === 1 ? groups[activeSelection]?.id : tab === 2 ? conversations[activeSelection]?.id : tab === 4 ? state.extensions[activeSelection]?.name : undefined;
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
  const removeExtensionAction = useCallback(() => runAction(() => controller.removeExtension(controller.runtime.store.listExtensions()[selected[4] || 0]?.name, ask)), [runAction, controller, selected, ask]);
  const configureAction = useCallback(() => runAction(() => controller.editSettings(ask)), [runAction, controller, ask]);
  const rotateCredentialsAction = useCallback(() => runAction(async () => { await controller.rotateCredentials(ask); }), [runAction, controller, ask]);
  const updateApplicationAction = useCallback(() => runAction(() => controller.updateApplication(ask)), [runAction, controller, ask]);
  const toggleAudit = useCallback(() => setShowAudit((value) => !value), []);
  const pageActions = useMemo(() => ({
    enabled: !form,
    tab,
    detail,
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
  }), [form, tab, detail, switchTab, nextTab, back, quit, moveSelection, open, createSessionAction, sessionAction, sendMessageAction, refreshDiffAction, addExtensionAction, removeExtensionAction, configureAction, rotateCredentialsAction, updateApplicationAction, toggleAudit]);
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
    if (!form && !detail && tab === 6 && event.eventType !== 'release') {
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
    const eligible = !form && !detail && [0, 5].includes(tab);
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
      : tab === 0 ? <Overview runtime={runtime} state={state} theme={theme} zh={zh} reveal={revealCredentials} />
        : tab === 1 ? <Sessions state={state} selected={activeSelection} theme={theme} zh={zh} onSelect={selectItem} />
          : tab === 2 ? <Messages state={state} selected={activeSelection} theme={theme} zh={zh} onSelect={selectItem} />
            : tab === 3 ? <DiffScreen snapshot={diff} theme={theme} zh={zh} />
              : tab === 4 ? <Extensions state={state} selected={activeSelection} theme={theme} zh={zh} onSelect={selectItem} />
                : tab === 5 ? <Settings runtime={runtime} theme={theme} zh={zh} reveal={revealCredentials} update={update} />
                  : <Logs runtime={runtime} logs={logs} theme={theme} zh={zh} showAudit={showAudit} page={logPage} anchorAt={logAnchorAt} />;

  const scrollKey = `${tab}-${detail?.kind || 'page'}-${detail?.id || ''}`;
  return (
    <FatalErrorBoundary runtime={runtime} theme={theme} zh={zh} onFatal={setFatalError}>
    <box width={width} height={height} flexDirection="column" backgroundColor={theme.background} onMouseUp={copySelection}>
      <Header runtime={runtime} theme={theme} pending={pending} zh={zh} />
      <TabBar active={tab} theme={theme} zh={zh} onSelect={switchTab} />
      <box height={1} flexShrink={0} backgroundColor={theme.background}><text fg={theme.border}>{'─'.repeat(Math.max(1, width))}</text></box>
      <scrollbox
        key={scrollKey}
        ref={scrollRef}
        flexGrow={1}
        minHeight={0}
        focused={!form}
        viewportCulling
        stickyScroll={detail?.kind === 'conversation'}
        stickyStart={detail?.kind === 'conversation' ? 'bottom' : undefined}
        verticalScrollbarOptions={{ visible: true }}
      >
        {content}
      </scrollbox>
      <Footer tab={tab} detail={detail} theme={theme} zh={zh} mouseEnabled={renderer.useMouse} notice={notice} />
      {form ? <FormDialog key={form.id} questions={form.questions} preamble={form.preamble} theme={theme} width={width} height={height} zh={zh} mouseEnabled={renderer.useMouse} onComplete={completeForm} onCancel={cancelForm} /> : null}
    </box>
    </FatalErrorBoundary>
  );
}
