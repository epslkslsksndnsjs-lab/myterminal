import path from 'node:path';
import { isWorkspaceRecordActive, type WorkspaceRecord } from './instances.js';

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

export function workspaceSelectionItems(
  records: WorkspaceRecord[],
  current: CurrentWorkspaceRuntime | undefined,
  zh: boolean,
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
      ? `${zh ? '当前进程运行中' : 'running in this process'} · ${host}:${port || '?'} · PID ${pid || '?'}`
      : activeElsewhere
        ? `${zh ? '其他进程运行中' : 'running in another process'} · ${host}:${port || '?'} · PID ${pid || '?'}`
        : (zh ? '未运行' : 'inactive');
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
      title: zh ? '添加新的工作区…' : 'Add a new workspace…',
      workspaceDir: '',
      status: zh ? '输入一个新的目录路径' : 'Enter a new directory path',
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
