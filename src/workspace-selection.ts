import path from 'node:path';
import { isWorkspaceRecordActive, type WorkspaceRecord } from './instances.js';
import type { Translate } from './tui/copy/i18n.js';

export type CurrentWorkspaceRuntime = {
  workspaceDir: string;
  host: string;
  port: number;
  pid?: number;
};

export const ADD_WORKSPACE_ID = '__add_workspace__';

export type WorkspaceSelectionItem = {
  id: string;
  title: string;
  workspaceDir: string;
  status: string;
  activity: 'current' | 'active' | 'inactive';
  active: boolean;
  disabled: boolean;
};

function sameWorkspace(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

/**
 * @param t — 语言无关的就地翻译函数（#31）。取自 `i18nFor(lang).t`，
 *            替代原先的 `zh: boolean`，让本模块不再自行判定语言。
 */
export function workspaceSelectionItems(
  records: WorkspaceRecord[],
  current: CurrentWorkspaceRuntime | undefined,
  t: Translate,
  includeAdd = false,
): WorkspaceSelectionItem[] {
  const items = records.map((record) => {
    const isCurrent = Boolean(current && sameWorkspace(record.workspaceDir, current.workspaceDir));
    const activeElsewhere = !isCurrent && isWorkspaceRecordActive(record);
    const host = isCurrent ? current!.host : (record.lastHost || '127.0.0.1');
    const port = isCurrent ? current!.port : record.lastPort;
    const pid = isCurrent ? (current!.pid || process.pid) : record.lastPid;
    const activity: WorkspaceSelectionItem['activity'] = isCurrent ? 'current' : activeElsewhere ? 'active' : 'inactive';
    const status = isCurrent
      ? `${t('running in this process', '当前进程运行中')} · ${host}:${port || '?'} · PID ${pid || '?'}`
      : activeElsewhere
        ? `${t('running in another process', '其他进程运行中')} · ${host}:${port || '?'} · PID ${pid || '?'}`
        : t('inactive', '未运行');
    return {
      id: record.id,
      title: record.label || path.basename(record.workspaceDir) || record.id,
      workspaceDir: record.workspaceDir,
      status,
      activity,
      active: activity !== 'inactive',
      disabled: activity === 'active',
    };
  });
  if (includeAdd) {
    items.push({
      id: ADD_WORKSPACE_ID,
      title: t('Add a new workspace…', '添加新的工作区…'),
      workspaceDir: '',
      status: t('Enter a new directory path', '输入一个新的目录路径'),
      activity: 'inactive',
      active: false,
      disabled: false,
    });
  }
  return items;
}

export function workspaceSelectionIndex(items: WorkspaceSelectionItem[], workspaceDir: string): number {
  const index = items.findIndex((item) => sameWorkspace(item.workspaceDir, workspaceDir));
  return index >= 0 ? index : 0;
}

export function selectedWorkspace(items: WorkspaceSelectionItem[], answer: string): WorkspaceSelectionItem | undefined {
  const index = Number(answer.trim());
  return Number.isInteger(index) && index >= 1 && index <= items.length ? items[index - 1] : undefined;
}

export function isAddWorkspaceSelection(item: WorkspaceSelectionItem | undefined): boolean {
  return item?.id === ADD_WORKSPACE_ID;
}
