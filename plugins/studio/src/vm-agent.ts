import { throwIfAborted } from './abort.ts';
/** Client and helpers for the agent service inside each VM (WindowsAgentArena-style Flask on port 5000, published as
 * access.agent_port). The service has no authentication and maps every error, including 404, to HTTP 500. */

export interface AgentResponse { status: number; data: Uint8Array; contentType: string }
/** status: the service's HTTP status when it answered with an error, so a script that failed in the VM is told from a
 * request that may never have arrived. */
export class VmAgentError extends Error { constructor(message: string, readonly status?: number) { super(message); } }

export interface AgentCallOptions { method?: string; body?: unknown; form?: Record<string, string>; timeoutMs: number; maxBytes?: number; signal?: AbortSignal; operation?: string }
/** Header naming the Studio operation of a request; the VM's trajectory recorder logs it with its time window
 * (agent_requests.jsonl), which tells Agent steps from human ones. */
export const OPERATION_HEADER = 'X-HarnessStudio-Operation';
/** One bounded request; redirects are refused and the body is capped. */
export async function agentCall(base: string, path: string, options: AgentCallOptions): Promise<AgentResponse> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs);
  const body = options.form ? new URLSearchParams(options.form).toString() : options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = options.form ? { 'content-type': 'application/x-www-form-urlencoded' } : options.body === undefined ? {} : { 'content-type': 'application/json' };
  if (options.operation) headers[OPERATION_HEADER] = options.operation;
  let response: Response;
  try {
    response = await fetch(base + path, { method: options.method ?? 'GET', headers, ...(body === undefined ? {} : { body }), signal, redirect: 'error' });
  } catch { throwIfAborted(options.signal); throw new VmAgentError('虚拟机内的操作服务暂时不可达或请求超时；虚拟机可能仍在启动，请稍后重试'); }
  const reader = response.body?.getReader(), parts: Uint8Array[] = [], limit = options.maxBytes ?? 4 * 1024 * 1024; let bytes = 0;
  if (reader) try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > limit) throw new VmAgentError('虚拟机操作服务的响应超过限制'); parts.push(part.value); } } finally { await reader.cancel().catch(() => {}); }
  const data = Buffer.concat(parts), contentType = response.headers.get('content-type') ?? '';
  if (!response.ok) {
    let message = data.toString('utf8').slice(0, 2000);
    try { const value = JSON.parse(message) as { message?: unknown }; if (typeof value.message === 'string') message = value.message; } catch { /* plain text error */ }
    throw new VmAgentError(`虚拟机操作失败（HTTP ${response.status}）：${message.trim().slice(0, 1000) || '无详情'}`, response.status);
  }
  return { status: response.status, data, contentType };
}
export function agentJson(response: AgentResponse): Record<string, unknown> {
  try { const value: unknown = JSON.parse(Buffer.from(response.data).toString('utf8')); if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>; } catch { /* below */ }
  throw new VmAgentError('虚拟机操作服务返回了无法解析的响应');
}

/** Width and height from a PNG IHDR chunk, or undefined for other data. */
export function pngSize(data: Uint8Array): { width: number; height: number } | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length < 24 || signature.some((byte, index) => data[index] !== byte)) return;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (value: string) => value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => code[0] === '#' ? String.fromCodePoint(Number.parseInt(code.slice(code[1] === 'x' || code[1] === 'X' ? 2 : 1), code[1] === 'x' || code[1] === 'X' ? 16 : 10)) : entities[code] ?? match);
function attribute(attributes: string, name: string): string | undefined { const match = new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}="([^"]*)"`).exec(attributes); return match ? decode(match[1]!) : undefined; }

/** Compact the service's accessibility XML into one indented line per visible element:
 * `tag "name" (x,y wxh)` plus [disabled]/[focused]. Invisible or zero-size subtrees are dropped.
 * With `window`, only top-level windows whose name contains it (case-insensitive) are kept. */
export function compactTree(xml: string, options: { window?: string; maxChars: number }): { text: string; truncated: boolean; windows: string[] } {
  const lines: string[] = [], windows: string[] = [], filter = options.window?.toLowerCase();
  let depth = 0, skipBelow = -1, length = 0, truncated = false;
  for (const match of xml.matchAll(/<(\/?)([^\s>/!?]+)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attributes, selfClosing] = match;
    if (closing) { depth--; if (skipBelow >= 0 && depth <= skipBelow) skipBelow = -1; continue; }
    const current = depth; if (!selfClosing) depth++;
    if (current === 0 || skipBelow >= 0) continue;
    const name = attribute(attributes!, 'name') ?? '', visible = attribute(attributes!, 'st:visible') !== 'false';
    const coord = /\((-?\d+),\s*(-?\d+)\)/.exec(attribute(attributes!, 'cp:screencoord') ?? ''), size = /\((\d+),\s*(\d+)\)/.exec(attribute(attributes!, 'cp:size') ?? '');
    const empty = !size || (size[1] === '0' && size[2] === '0');
    if (current === 1) windows.push(name);
    if (!visible || empty || (current === 1 && filter !== undefined && !name.toLowerCase().includes(filter))) { if (!selfClosing) skipBelow = current; continue; }
    const flags = [attribute(attributes!, 'st:enabled') === 'false' ? 'disabled' : '', attribute(attributes!, 'st:focused') === 'true' ? 'focused' : ''].filter(Boolean);
    const line = `${'  '.repeat(current - 1)}${tag}${name ? ` "${name.replace(/\s+/g, ' ').slice(0, 120)}"` : ''}${coord && size ? ` (${coord[1]},${coord[2]} ${size[1]}x${size[2]})` : ''}${flags.length ? ` [${flags.join(',')}]` : ''}`;
    if (length + line.length + 1 > options.maxChars) { truncated = true; break; }
    lines.push(line); length += line.length + 1;
  }
  return { text: lines.join('\n'), truncated, windows: windows.filter(Boolean) };
}

/** Mouse and keyboard steps executed inside the VM with pyautogui (mouse, keys) and the clipboard (text). */
export type InputAction =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clicks?: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'drag'; x: number; y: number; toX: number; toY: number; button?: 'left' | 'right' | 'middle' }
  | { type: 'scroll'; amount: number; x?: number; y?: number }
  | { type: 'type'; text: string }
  | { type: 'key'; keys: string[] }
  | { type: 'wait'; seconds: number };
function coordinate(value: unknown, label: string): number { if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10000) throw new Error(`${label} 须为 0–10000 的整数屏幕坐标`); return value; }
/** Validate model-supplied actions; nothing unvalidated reaches the VM. */
export function inputActions(value: unknown): InputAction[] {
  if (!Array.isArray(value) || !value.length || value.length > 50) throw new Error('actions 须为 1–50 个操作组成的数组');
  return value.map((raw, index): InputAction => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`第 ${index + 1} 个操作须为对象`);
    const row = raw as Record<string, unknown>, button = row.button ?? 'left';
    if (!['left', 'right', 'middle'].includes(button as string)) throw new Error('button 只能是 left、right 或 middle');
    switch (row.type) {
      case 'click': { const clicks = row.clicks ?? 1; if (![1, 2, 3].includes(clicks as number)) throw new Error('clicks 只能是 1–3'); return { type: 'click', x: coordinate(row.x, 'x'), y: coordinate(row.y, 'y'), button: button as 'left', clicks: clicks as number }; }
      case 'move': return { type: 'move', x: coordinate(row.x, 'x'), y: coordinate(row.y, 'y') };
      case 'drag': return { type: 'drag', x: coordinate(row.x, 'x'), y: coordinate(row.y, 'y'), toX: coordinate(row.toX, 'toX'), toY: coordinate(row.toY, 'toY'), button: button as 'left' };
      case 'scroll': { if (typeof row.amount !== 'number' || !Number.isInteger(row.amount) || Math.abs(row.amount) > 50) throw new Error('scroll 的 amount 须为 -50–50 的整数'); return { type: 'scroll', amount: row.amount, ...(row.x === undefined ? {} : { x: coordinate(row.x, 'x'), y: coordinate(row.y, 'y') }) }; }
      case 'type': { if (typeof row.text !== 'string' || !row.text || row.text.length > 4000) throw new Error('type 的 text 须为 1–4000 个字符'); return { type: 'type', text: row.text }; }
      case 'key': { if (!Array.isArray(row.keys) || !row.keys.length || row.keys.length > 5 || row.keys.some(key => typeof key !== 'string' || !/^[a-z0-9]{1,12}$/i.test(key))) throw new Error('key 的 keys 须为 1–5 个 pyautogui 按键名，例如 ["ctrl","s"]'); return { type: 'key', keys: (row.keys as string[]).map(key => key.toLowerCase()) }; }
      case 'wait': { if (typeof row.seconds !== 'number' || !(row.seconds > 0) || row.seconds > 10) throw new Error('wait 的 seconds 须在 0–10 之间'); return { type: 'wait', seconds: row.seconds }; }
      default: throw new Error(`第 ${index + 1} 个操作的 type 不受支持`);
    }
  });
}
/** Python executed by /execute_windows. Actions travel only as a JSON string literal; the service treats any
 * printed text containing "error" as a failure, so the script prints nothing. Text is pasted through the clipboard
 * (restored afterwards) with the input method closed: per-key Unicode input lost characters in Notepad and under
 * a Chinese IME. \n and \t in text press Enter and Tab. */
export function inputScript(actions: InputAction[]): string {
  return [
    'import ctypes, json, re, time, pyautogui, win32clipboard, win32con',
    'pyautogui.FAILSAFE = False',
    'def close_ime():',
    '    # An open (e.g. Chinese) input method must not compose the pasted text or the Enter/Tab keys.',
    '    hwnd = ctypes.windll.user32.GetForegroundWindow()',
    '    ime = ctypes.windll.imm32.ImmGetDefaultIMEWnd(hwnd)',
    '    if ime: ctypes.windll.user32.SendMessageW(ime, 0x0283, 0x0006, 0)',
    'def clipboard(value=None):',
    '    win32clipboard.OpenClipboard()',
    '    try:',
    '        if value is None:',
    '            try: return win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT)',
    '            except Exception: return None',
    '        win32clipboard.EmptyClipboard(); win32clipboard.SetClipboardData(win32con.CF_UNICODETEXT, value)',
    '    finally: win32clipboard.CloseClipboard()',
    'def type_text(text):',
    '    close_ime()',
    '    previous = clipboard()',
    '    try:',
    "        for part in re.split('(\\n|\\t)', text):",
    "            if part == '\\n': pyautogui.press('enter')",
    "            elif part == '\\t': pyautogui.press('tab')",
    '            elif part:',
    '                clipboard(part)',
    "                pyautogui.hotkey('ctrl', 'v')",
    '            time.sleep(0.25)',
    '    finally:',
    '        if previous is not None: clipboard(previous)',
    `actions = json.loads(${JSON.stringify(JSON.stringify(actions))})`,
    'for a in actions:',
    "    t = a['type']",
    "    if t == 'click': pyautogui.click(a['x'], a['y'], clicks=a.get('clicks', 1), interval=0.1, button=a.get('button', 'left'))",
    "    elif t == 'move': pyautogui.moveTo(a['x'], a['y'])",
    "    elif t == 'drag':",
    "        pyautogui.moveTo(a['x'], a['y'])",
    "        pyautogui.dragTo(a['toX'], a['toY'], duration=0.4, button=a.get('button', 'left'))",
    "    elif t == 'scroll': pyautogui.scroll(a['amount'], x=a.get('x'), y=a.get('y'))",
    "    elif t == 'type': type_text(a['text'])",
    "    elif t == 'key': pyautogui.hotkey(*a['keys'])",
    "    elif t == 'wait': time.sleep(a['seconds'])",
    '    time.sleep(0.15)',
  ].join('\n');
}

/** Python for /execute_windows that runs a command line with a UTF-8 console and stores its exit code and output
 * as JSON at resultPath (the service's /execute loses non-ASCII output).
 * Output goes to files, not pipes, and a timeout ends the whole process tree: with subprocess.run(timeout=…) only
 * cmd.exe was killed, its PowerShell child kept running and held the pipes, so the request never returned. */
export function runScript(command: string, resultPath: string, timeoutSeconds: number): string {
  return [
    'import json, locale, os, subprocess',
    `command = json.loads(${JSON.stringify(JSON.stringify(command))})`,
    `path = os.path.expandvars(json.loads(${JSON.stringify(JSON.stringify(resultPath))}))`,
    'LIMIT = 262144',
    'def text(name):',
    '    try:',
    '        with open(name, "rb") as handle:',
    '            handle.seek(0, 2); size = handle.tell(); handle.seek(max(0, size - LIMIT)); data = handle.read()',
    '    except OSError: return ""',
    '    try: os.remove(name)',
    '    except OSError: pass',
    '    try: value = data.decode("utf-8")',
    '    except UnicodeDecodeError: value = data.decode(locale.getpreferredencoding(False), "replace")',
    '    return value if size <= LIMIT else "…（前 %d 字节已省略）\\n" % (size - LIMIT) + value',
    'result = {"returncode": None}',
    'with open(path + ".out", "wb") as out, open(path + ".err", "wb") as err:',
    '    process = subprocess.Popen("chcp 65001>nul & " + command, shell=True, stdin=subprocess.DEVNULL, stdout=out, stderr=err, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)',
    '    try:',
    `        result["returncode"] = process.wait(timeout=${timeoutSeconds})`,
    '    except subprocess.TimeoutExpired:',
    '        subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
    '        try: process.wait(timeout=15)',
    '        except subprocess.TimeoutExpired: pass',
    '        result["timedOut"] = True',
    'result["stdout"] = text(path + ".out"); result["stderr"] = text(path + ".err")',
    'with open(path, "w", encoding="utf-8") as handle: json.dump(result, handle, ensure_ascii=False)',
  ].join('\n');
}
