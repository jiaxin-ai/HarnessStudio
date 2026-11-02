import { readFile } from 'node:fs/promises';

/**
 * Human-facing prompt provenance stored inside a Markdown comment. This block
 * is parsed at startup and is never returned as model instructions.
 */
export interface PromptDocumentMetadata {
  id: string;
  title: string;
  loadStage: string;
  modelScopes: string[];
  contextRecords: string[];
  reloadPolicy: string;
}

export interface PromptDocument {
  metadata: PromptDocumentMetadata;
  /** Exact Markdown body after the required metadata separator. */
  prompt: string;
}

/** A startup-validated template whose only editable slot is replaced once. */
export interface SinglePlaceholderPromptTemplate {
  readonly placeholder: string;
  render(value: string): string;
}

export const PROMPT_METADATA_MARKER = 'HARNESSSTUDIO_PROMPT_METADATA';
const opening = `<!-- ${PROMPT_METADATA_MARKER}`;
const fields = ['id', 'title', 'loadStage', 'modelScopes', 'contextRecords', 'reloadPolicy'] as const;
const fieldSet = new Set<string>(fields);

function invalid(sourceName: string, reason: string): never {
  throw new Error(`Invalid prompt document ${sourceName}: ${reason}`);
}

function object(value: unknown, sourceName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(sourceName, 'metadata must be a JSON object');
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, sourceName: string, maximum = 1000): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    invalid(sourceName, `${field} must be a nonempty, trimmed string no longer than ${maximum} characters`);
  }
  return value;
}

function textList(value: unknown, field: string, sourceName: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) invalid(sourceName, `${field} must be a nonempty array with at most 20 entries`);
  const result = value.map((entry, index) => text(entry, `${field}[${index}]`, sourceName, 500));
  if (new Set(result).size !== result.length) invalid(sourceName, `${field} must not contain duplicates`);
  return result;
}

/**
 * Return root-object member names from already syntax-validated JSON. Tracking
 * container depth and consuming complete JSON strings avoids mistaking escaped
 * quotes, object-looking string data or nested members for metadata fields.
 */
function topLevelJsonKeys(source: string, sourceName: string): string[] {
  const keys: string[] = []; let depth = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '"') {
      const start = index;
      for (index++; index < source.length; index++) {
        if (source[index] === '\\') { index++; continue; }
        if (source[index] === '"') break;
      }
      // JSON.parse has already accepted the document, so an unterminated string
      // is unreachable; retain a fail-closed guard if this helper is reordered.
      if (index >= source.length) invalid(sourceName, 'metadata contains an unterminated JSON string');
      let cursor = index + 1;
      while (cursor < source.length && [' ', '\t', '\r', '\n'].includes(source[cursor]!)) cursor++;
      if (depth === 1 && source[cursor] === ':') keys.push(JSON.parse(source.slice(start, index + 1)) as string);
      continue;
    }
    if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') depth--;
  }
  return keys;
}

function metadata(value: unknown, sourceName: string): PromptDocumentMetadata {
  const row = object(value, sourceName), keys = Object.keys(row);
  const unknown = keys.filter(key => !fieldSet.has(key));
  const missing = fields.filter(key => !Object.hasOwn(row, key));
  if (unknown.length) invalid(sourceName, `unknown metadata field(s): ${unknown.join(', ')}`);
  if (missing.length) invalid(sourceName, `missing metadata field(s): ${missing.join(', ')}`);
  if (keys.length !== fields.length) invalid(sourceName, 'metadata fields must appear exactly once');
  const id = text(row.id, 'id', sourceName, 80);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/u.test(id)) invalid(sourceName, 'id must use lowercase ASCII letters, digits and interior hyphens');
  return {
    id,
    title: text(row.title, 'title', sourceName, 160),
    loadStage: text(row.loadStage, 'loadStage', sourceName),
    modelScopes: textList(row.modelScopes, 'modelScopes', sourceName),
    contextRecords: textList(row.contextRecords, 'contextRecords', sourceName),
    reloadPolicy: text(row.reloadPolicy, 'reloadPolicy', sourceName, 500),
  };
}

/**
 * Parse one editable Markdown prompt. The metadata comment must be the first
 * bytes in the file, must contain strict JSON, and must be followed by one
 * blank line. Invalid documents fail startup instead of leaking annotations
 * into the model prompt or silently using a partial document.
 */
export function parsePromptDocument(source: string, sourceName = '<prompt>'): PromptDocument {
  if (!source.startsWith(`${opening}\n`) && !source.startsWith(`${opening}\r\n`)) invalid(sourceName, `must start with <!-- ${PROMPT_METADATA_MARKER}`);
  const newline = source.startsWith(`${opening}\r\n`) ? '\r\n' : '\n';
  const metadataStart = opening.length + newline.length;
  const close = source.indexOf(`${newline}-->`, metadataStart);
  if (close < 0) invalid(sourceName, 'metadata comment is not closed on its own line');
  const afterClose = close + newline.length + 3;
  if (!source.startsWith(`${newline}${newline}`, afterClose)) invalid(sourceName, 'metadata comment must be followed by one blank line');
  const bodyStart = afterClose + newline.length * 2;
  if (source.indexOf(opening, bodyStart) >= 0) invalid(sourceName, 'contains more than one metadata block');
  const rawMetadata = source.slice(metadataStart, close);
  let parsed: unknown;
  try { parsed = JSON.parse(rawMetadata); }
  catch { invalid(sourceName, 'metadata must be valid JSON'); }
  const keys = topLevelJsonKeys(rawMetadata, sourceName), duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate !== undefined) invalid(sourceName, `duplicate metadata field: ${duplicate}`);
  const prompt = source.slice(bodyStart);
  if (!prompt.trim()) invalid(sourceName, 'prompt body must not be empty');
  return { metadata: metadata(parsed, sourceName), prompt };
}

export async function loadPromptFile(path: string): Promise<PromptDocument> {
  return parsePromptDocument(await readFile(path, 'utf8'), path);
}

/**
 * Compile a prompt body containing exactly one named `{{PLACEHOLDER}}`.
 * Validation happens before any conversation starts. Rendering concatenates
 * the supplied value between the already-validated prefix and suffix, so
 * placeholder-like text inside live JSON is never interpreted a second time.
 */
export function compileSinglePlaceholderPrompt(prompt: string, placeholder: string,
  sourceName = '<prompt>'): SinglePlaceholderPromptTemplate {
  if (!/^[A-Z][A-Z0-9_]{0,79}$/u.test(placeholder)) invalid(sourceName, 'placeholder name must use uppercase ASCII letters, digits and underscores');
  const token = `{{${placeholder}}}`, first = prompt.indexOf(token);
  if (first < 0) invalid(sourceName, `must contain exactly one ${token} placeholder`);
  if (prompt.indexOf(token, first + token.length) >= 0) invalid(sourceName, `must contain exactly one ${token} placeholder`);
  const prefix = prompt.slice(0, first), suffix = prompt.slice(first + token.length);
  if (prefix.includes('{{') || prefix.includes('}}') || suffix.includes('{{') || suffix.includes('}}')) {
    invalid(sourceName, `contains an unknown or malformed placeholder; only ${token} is allowed`);
  }
  return Object.freeze({
    placeholder,
    render(value: string) {
      if (typeof value !== 'string') invalid(sourceName, 'placeholder value must be a string');
      return prefix + value + suffix;
    },
  });
}
