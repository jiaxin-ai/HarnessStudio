import type { CompletionFileSubmission, SnapshotFile } from '@harnessstudio/studio/domain-types';

const sizeUnits = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;
const roundSize = (value: number) => Math.round((value + Number.EPSILON * Math.max(1, value)) * 100) / 100;

/** Compact binary units; promote a rounded 1024 rather than printing 1024 KiB. */
export function formatFileSize(bytes: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < sizeUnits.length - 1) { value /= 1024; unit++; }
  let rounded = roundSize(value);
  if (rounded >= 1024 && unit < sizeUnits.length - 1) {
    value /= 1024; unit++; rounded = roundSize(value);
  }
  return `${rounded}${sizeUnits[unit]}`;
}

export type CompletionFileState = 'pending' | 'submitted' | 'modified';

const modifiedTime = (value?: string): number | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
};

/** Match saved content and, when available, modification times of the submitted version. */
export function completionFileState(file: SnapshotFile, submission?: CompletionFileSubmission): CompletionFileState {
  const previous = Array.isArray(submission?.files) ? submission.files.filter(submitted => submitted.path === file.path) : [];
  if (!previous.length) return 'pending';
  const currentTime = modifiedTime(file.modifiedAt);
  const matches = previous.some(submitted => {
    if (submitted.version !== file.version || submitted.bytes !== file.bytes) return false;
    const submittedTime = modifiedTime(submitted.modifiedAt);
    // Older snapshots may lack timestamps; retain content-based compatibility for those files.
    return currentTime === undefined || submittedTime === undefined || currentTime === submittedTime;
  });
  return matches ? 'submitted' : 'modified';
}

export function isSubmittedFile(file: SnapshotFile, submission?: CompletionFileSubmission): boolean {
  return completionFileState(file, submission) === 'submitted';
}
