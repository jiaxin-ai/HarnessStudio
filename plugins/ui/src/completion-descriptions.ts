import type { CompletionWorkspaceFile, SnapshotFile, TaskCompletionPreview } from '@harnessstudio/studio/domain-types';

export type DescriptionFile = CompletionWorkspaceFile;
export type FileDescriptionDrafts = Record<string, string>;

/** Presence tracks a human edit, including an intentional empty or whitespace-only value. */
export function hasDescriptionEdit(drafts: FileDescriptionDrafts, path: string): boolean { return Object.hasOwn(drafts, path); }
export function descriptionDraftValue(drafts: FileDescriptionDrafts, path: string): string { return hasDescriptionEdit(drafts, path) ? drafts[path]! : ''; }
export function descriptionPlaceholder(file: DescriptionFile): string {
  const hint = file.submissionDescription;
  return hint?.version === file.version && hint.text.trim() ? hint.text.trim() : '简要说明这个文件的内容与用途';
}
export function missingEditedDescriptions(files: readonly SnapshotFile[], drafts: FileDescriptionDrafts): Set<string> {
  return new Set(files.filter(file => hasDescriptionEdit(drafts, file.path) && !descriptionDraftValue(drafts, file.path).trim()).map(file => file.path));
}
/** Capture the visible placeholder at click time; a later background result must not change this submission. */
export function descriptionSubmissionFiles(files: readonly DescriptionFile[], drafts: FileDescriptionDrafts): { path: string; description: string }[] {
  return files.map(file => ({ path: file.path, description: hasDescriptionEdit(drafts, file.path) ? descriptionDraftValue(drafts, file.path).trim() : descriptionPlaceholder(file) }));
}

/** Suggestion-only polling must never replace goal confirmations or a changed workspace. */
export function mergeDescriptionHints(current: TaskCompletionPreview, next: TaskCompletionPreview): TaskCompletionPreview | undefined {
  if (current.taskId !== next.taskId || current.projectId !== next.projectId || current.taskRevision !== next.taskRevision
    || current.workspaceVersion !== next.workspaceVersion || current.childrenVersion !== next.childrenVersion
    || current.submittedFiles?.id !== next.submittedFiles?.id || current.files.length !== next.files.length
    || JSON.stringify(current.blockers) !== JSON.stringify(next.blockers)) return;
  const newer = new Map(next.files.map(file => [file.path, file as DescriptionFile]));
  let changed = false;
  const files = current.files.map(file => {
    const incoming = newer.get(file.path);
    if (!incoming || incoming.version !== file.version || incoming.bytes !== file.bytes || incoming.modifiedAt !== file.modifiedAt) return undefined;
    const hint = incoming.submissionDescription;
    if (!hint || hint.version !== file.version) return file;
    const previous = (file as DescriptionFile).submissionDescription;
    if (previous?.version === hint.version && previous.text === hint.text && previous.status === hint.status) return file;
    changed = true; return { ...file, submissionDescription: hint };
  });
  if (files.some(file => file === undefined)) return;
  return changed ? { ...current, files: files as DescriptionFile[] } : current;
}
