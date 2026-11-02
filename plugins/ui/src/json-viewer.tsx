import { useMemo, useState, type ReactNode } from 'react';
import { JSONTree } from 'react-json-tree';

const theme = {
  scheme: 'HarnessStudio', author: 'HarnessStudio',
  base00: '#ffffff', base01: '#f6f8fb', base02: '#e8edf4', base03: '#93a0b2',
  base04: '#75869d', base05: '#42546c', base06: '#34465e', base07: '#22324b',
  base08: '#ad6265', base09: '#9c743d', base0A: '#92773f', base0B: '#54826d',
  base0C: '#527c89', base0D: '#5b779e', base0E: '#8c6d9d', base0F: '#9c6f5f',
};
export type ParsedJsonText = { json: true; value: unknown } | { json: false };

/** Strict whole-document detection: incomplete streaming text always remains text. */
export function parseJsonText(text: string, allowPrimitive = false): ParsedJsonText {
  const trimmed = text.trim();
  if (!trimmed || !allowPrimitive && !['{', '['].includes(trimmed[0]!)) return { json: false };
  try { const value: unknown = JSON.parse(trimmed); return { json: true, value }; }
  catch { return { json: false }; }
}

/** An encoded JSON string stays visibly a string; its optional tree is only a preview. */
function JsonString({ value, embedded, depth }: { value: string; embedded: boolean; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const parsed = useMemo(() => expanded && embedded ? parseJsonText(value) : { json: false } as const, [value, expanded, embedded]);
  return <details className="json-long-string" onClick={event => event.stopPropagation()} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary><span>{JSON.stringify(value.slice(0, 160))}{value.length > 160 ? '…' : ''}</span><small>{embedded ? 'JSON 字符串 · 展开预览' : `${value.length.toLocaleString()} 字符 · 展开全文`}</small></summary>
    {expanded && (parsed.json ? <div className="json-string-preview"><small>原始字段类型为字符串，以下为解析预览</small><JsonViewer value={parsed.value} depth={depth + 1} /></div> : <pre>{JSON.stringify(value)}</pre>)}
  </details>;
}

/** One shared tree, palette and lazy long-value policy for every JSON surface. */
export function JsonViewer({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [identity, setIdentity] = useState({ value, revision: 0 });
  if (!Object.is(identity.value, value)) setIdentity({ value, revision: identity.revision + 1 });
  return <div className="json-viewer"><JSONTree key={identity.revision} data={value} theme={theme} invertTheme={false} keyPath={['root']} collectionLimit={50}
    shouldExpandNodeInitially={(_path, _value, level) => level === 0}
    valueRenderer={(rendered, original, ...path) => {
      if (typeof original !== 'string') return String(rendered);
      const trimmed = original.trim(), embedded = depth < 4 && (trimmed.startsWith('{') && trimmed.endsWith('}') || trimmed.startsWith('[') && trimmed.endsWith(']'));
      return embedded || original.length > 240 ? <JsonString key={JSON.stringify(path)} value={original} embedded={embedded} depth={depth} /> : String(rendered);
    }} /></div>;
}

/** Read-only presentation never rewrites the source string or fetches another copy. */
export function JsonText({ text, allowPrimitive = false, fallback }: { text: string; allowPrimitive?: boolean; fallback?: ReactNode }) {
  const parsed = useMemo(() => parseJsonText(text, allowPrimitive), [text, allowPrimitive]);
  return parsed.json ? <JsonViewer value={parsed.value} /> : <>{fallback ?? <pre>{text}</pre>}</>;
}
