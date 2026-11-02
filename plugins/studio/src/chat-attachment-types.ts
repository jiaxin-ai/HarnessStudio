/** Browser-safe references to conversation-private engineering reference uploads. */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types';

export type ChatAttachmentMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf';
export interface ChatAttachmentUpload { name: string; mediaType: ChatAttachmentMediaType; data: string }
export interface ChatAttachmentOwner { id: string; scope: 'project' | 'task'; projectId: string; taskId?: string }
export interface ChatAttachmentView {
  id: string;
  name: string;
  mediaType: ChatAttachmentMediaType;
  bytes: number;
  createdAt: string;
  /** PDF pages are rasterized; these are the exact admitted image references supplied to the model. */
  images: ImageAttachmentRef[];
}
export const CHAT_ATTACHMENT_LIMITS = Object.freeze({ maxUploads: 4, maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024, maxImages: 6, maxPdfPages: 6, maxImageDimension: 2048 });
