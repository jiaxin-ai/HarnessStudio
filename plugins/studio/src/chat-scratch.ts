import type { WorkspaceLease, ScratchFileList, ScratchTreeEntry, ScratchTreeValue, ScratchBinaryValue } from './workspace.js';
import { WorkspaceFiles } from './workspace.js';

export interface ScratchValue {
  path: string;
  bytes: number;
  totalChars: number;
  version: string;
}
export interface ScratchPage extends ScratchValue {
  content: string;
  offset: number;
  nextOffset?: number;
}
export interface ScratchMatch { line: number; column: number; text: string }
export interface ScratchSearch { path: string; query: string; matches: ScratchMatch[]; truncated: boolean }

/** Temporary artifacts belong to one persisted chat UUID within its task's workspace. */
export class ChatScratch {
  constructor(private readonly files: WorkspaceFiles) {}

  ensure(lease: WorkspaceLease, chatId: string): Promise<string> {
    return this.files.ensureScratch(lease, chatId);
  }

  /** The chat's temporary directory if it exists; never creates it. */
  existing(lease: WorkspaceLease, chatId: string): Promise<string | undefined> {
    return this.files.existingScratch(lease, chatId);
  }

  async write(lease: WorkspaceLease, chatId: string, path: string, content: string): Promise<ScratchValue> {
    const value = await this.files.writeScratch(lease, chatId, path, content);
    return { path: value.path, bytes: value.bytes, totalChars: Array.from(value.content).length, version: value.version };
  }

  /** Offsets count Unicode code points, so pages never divide a surrogate pair. */
  async read(lease: WorkspaceLease, chatId: string, path: string, offset = 0, limit = 6000, signal?: AbortSignal): Promise<ScratchPage> {
    return this.files.readScratchPage(lease, chatId, path, offset, limit, signal);
  }

  /** Literal, case-sensitive line search; regexes and unbounded result bodies are not accepted. */
  async search(lease: WorkspaceLease, chatId: string, path: string, query: string, limit = 20, signal?: AbortSignal): Promise<ScratchSearch> {
    return this.files.searchScratchText(lease, chatId, path, query, limit, signal);
  }

  writeArtifact(lease: WorkspaceLease, chatId: string, path: string, data: Uint8Array, signal?: AbortSignal) {
    return this.files.writeScratchBytes(lease, chatId, path, data, signal);
  }

  readArtifact(lease: WorkspaceLease, chatId: string, path: string, maxBytes?: number, signal?: AbortSignal): Promise<ScratchBinaryValue> {
    return this.files.readScratchBytes(lease, chatId, path, maxBytes, signal);
  }

  writeTree(lease: WorkspaceLease, chatId: string, destination: string, entries: readonly ScratchTreeEntry[], signal?: AbortSignal): Promise<ScratchTreeValue> {
    return this.files.writeScratchTree(lease, chatId, destination, entries, signal);
  }

  list(lease: WorkspaceLease, chatId: string, limit = 100, offset = 0): Promise<ScratchFileList> {
    return this.files.listScratch(lease, chatId, limit, offset);
  }
}
