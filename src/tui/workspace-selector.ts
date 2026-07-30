import type { WorkspaceRecord } from '../instances.js';
import { workspaceSelectionIndex, workspaceSelectionItems, type CurrentWorkspaceRuntime, type WorkspaceSelectionItem } from '../workspace-selection.js';
import { workspaceChoiceQuestion } from './form-model.js';
import type { FormQuestion } from './contracts.js';
import type { Translate } from './copy/i18n.js';

export type WorkspaceSelectorModel = {
  items: WorkspaceSelectionItem[];
  question: FormQuestion;
};

export function buildWorkspaceSelectorModel(input: {
  label: string;
  records: WorkspaceRecord[];
  currentWorkspaceDir: string;
  currentRuntime?: CurrentWorkspaceRuntime;
  t: Translate;
}): WorkspaceSelectorModel {
  const items = workspaceSelectionItems(input.records, input.currentRuntime, input.t, true);
  return {
    items,
    question: workspaceChoiceQuestion(
      input.label,
      items,
      workspaceSelectionIndex(items, input.currentWorkspaceDir),
    ),
  };
}
