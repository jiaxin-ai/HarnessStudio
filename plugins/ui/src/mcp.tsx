import { useCallback, useEffect, useState } from 'react';
import type { McpProbe, McpServerView, PluginMcpView } from '@harnessstudio/studio/mcp';
import { api } from './api.ts';
import { useNoSoftware } from './software-backend.ts';

interface HeaderRow { name: string; value: string; saved: boolean }
interface Form { originalName?: string; name: string; url: string; note: string; headers: HeaderRow[] }
const blank = (): Form => ({ name: '', url: '', note: '', headers: [] });

const pluginStates: Record<PluginMcpView['state'], string> = { connected: '已连接', unreachable: '连接失败', disabled: '插件已停用', unsupported: '暂不支持', incomplete: '未接入', conflict: '名称冲突' };
export const pluginMcpState = (server: PluginMcpView) => server.state === 'connected' ? `已连接 · ${server.tools.length} 个工具` : pluginStates[server.state];

/** Third-party tool servers the Agent can call; added by address, tested before saving. */
export function McpPage({ onPlugins }: { onPlugins?(): void }) {
  const noSoftware = useNoSoftware();
  const [servers, setServers] = useState<McpServerView[]>(), [plugins, setPlugins] = useState<PluginMcpView[]>([]), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Form>(), [check, setCheck] = useState<McpProbe & { busy?: boolean }>(), [formError, setFormError] = useState('');
  const load = useCallback(async () => { const value = await api<{ servers: McpServerView[]; plugins?: PluginMcpView[] }>('mcp'); setServers(value.servers); setPlugins(value.plugins ?? []); }, []);
  useEffect(() => { void load().catch(error => setMessage(error instanceof Error ? error.message : 'MCP 服务读取失败')); }, [load]);
  const run = async (action: () => Promise<string | void>) => {
    setBusy(true); setMessage('');
    try { const done = await action(); await load(); if (done) setMessage(done); }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const payload = (value: Form) => ({ ...(value.originalName ? { originalName: value.originalName } : {}), name: value.name.trim(), url: value.url.trim(), note: value.note,
    headers: value.headers.filter(row => row.name.trim()).map(row => ({ name: row.name.trim(), value: row.value })) });
  const open = (server?: McpServerView) => { setMessage(''); setCheck(undefined); setFormError('');
    setForm(server ? { originalName: server.name, name: server.name, url: server.url, note: server.note ?? '', headers: server.headerNames.map(name => ({ name, value: '', saved: true })) } : blank()); };
  const patch = (fields: Partial<Form>) => { setForm(previous => previous && { ...previous, ...fields }); setCheck(undefined); };
  const test = async () => {
    if (!form) return;
    setCheck({ ok: false, tools: [], busy: true }); setFormError('');
    try { setCheck(await api<McpProbe>('mcp/test', payload(form))); }
    catch (error) { setCheck(undefined); setFormError(error instanceof Error ? error.message : '测试失败'); }
  };
  const save = async () => {
    if (!form) return;
    setBusy(true); setFormError('');
    try {
      const server = await api<McpServerView>('mcp/save', payload(form));
      setForm(undefined); await load();
      setMessage(server.state === 'connected' ? `已保存 ${server.name}，Agent 现在能用它的 ${server.tools.length} 个工具。` : `已保存 ${server.name}，但现在连不上：${server.error ?? '请检查地址'}`);
    } catch (error) { setFormError(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  };
  return <section className="skills-page mcp-page" aria-label="MCP 工具页面">
    <header><div><h2>MCP 工具</h2><p>MCP 服务是别人写好、在网络上提供工具的程序，例如某个数据库、知识库或在线服务的 MCP 服务。在这里填上它的地址，所有对话里的 Agent 就能直接调用它提供的工具。这里只接 Studio 能直接访问的外部服务；{noSoftware ? '' : '要在虚拟机里操作工程软件，不用 MCP，而是把脚本做成项目技能（放在 F:\\skills），由 Agent 在虚拟机里运行。'}需要 Studio 启动本地程序的那种（说明里写 npx 或 python 的）暂不支持。</p></div>
      <div className="skills-actions"><button type="button" disabled={busy} onClick={() => open()}>添加 MCP 服务</button></div>
    </header>
    <div className="model-status" role="status">{message}</div>
    <div className="skills-list" aria-label="MCP 服务列表">
      {!servers ? <p className="skills-empty">正在读取 MCP 服务…</p> : !servers.length ? <p className="skills-empty">还没有 MCP 服务。点“添加 MCP 服务”，填上服务地址。</p>
        : servers.map(server => <article key={server.name} className={`skill-row mcp-row${server.enabled ? '' : ' is-disabled'}`}>
          <div className="skill-main">
            <strong><code>{server.name}</code><span className={`mcp-state is-${server.state}`}>{server.state === 'connected' ? `已连接 · ${server.tools.length} 个工具` : server.state === 'disabled' ? '已停用' : '连接失败'}</span></strong>
            <small className="mcp-url" title={server.url}>{server.url}{server.headerNames.length ? ` · 请求头：${server.headerNames.join('、')}` : ''}</small>
            {server.note && <p>{server.note}</p>}
            {server.state === 'unreachable' && <p className="skill-error">{server.error}</p>}
            {server.tools.length > 0 && <details className="mcp-tools"><summary>查看工具</summary><ul>{server.tools.map(tool => <li key={tool.name}><code>{tool.name}</code>{tool.description && <span>{tool.description}</span>}</li>)}</ul></details>}
          </div>
          <div className="skill-controls">
            <label className="skill-switch"><input type="checkbox" aria-label={`启用 ${server.name}`} checked={server.enabled} disabled={busy} onChange={event => { const enabled = event.target.checked; setServers(previous => previous?.map(row => row.name === server.name ? { ...row, enabled } : row)); void run(async () => { await api('mcp/toggle', { name: server.name, enabled }); return enabled ? `已启用 ${server.name}。` : `已停用 ${server.name}，Agent 不会再看到它的工具。`; }); }} />{server.enabled ? '已启用' : '已停用'}</label>
            {server.state === 'unreachable' && <button type="button" disabled={busy} onClick={() => { void run(async () => { await api('mcp/reconnect', { name: server.name }); return `已重新连接 ${server.name}。`; }); }}>重新连接</button>}
            <button type="button" disabled={busy} onClick={() => open(server)}>编辑</button>
            <button type="button" className="skill-delete" disabled={busy} onClick={() => { if (window.confirm(`删除 MCP 服务 ${server.name}？Agent 将不再能用它的工具。`)) void run(async () => { await api('mcp/delete', { name: server.name }); return `已删除 ${server.name}。`; }); }}>删除</button>
          </div>
        </article>)}
    </div>
    {plugins.length > 0 && <section className="skills-plugin-group" aria-label="来自插件的 MCP 服务">
      <header><h3>来自插件</h3><p>这些服务随插件安装，启用、停用、填写密钥和删除在{onPlugins ? <button type="button" className="skills-link" onClick={onPlugins}>插件页面</button> : '插件页面'}操作。</p></header>
      {plugins.map(server => <article key={`${server.plugin}/${server.name}`} className={`skill-row mcp-row${server.state === 'connected' || server.state === 'unreachable' ? '' : ' is-disabled'}`}>
        <div className="skill-main">
          <strong><code>{server.name}</code><span className={`mcp-state is-${server.state}`}>{pluginMcpState(server)}</span><span className="skill-plugin-name">插件 {server.plugin}</span></strong>
          {server.url && <small className="mcp-url" title={server.url}>{server.url}{server.headerNames.length ? ` · 请求头：${server.headerNames.join('、')}` : ''}</small>}
          {server.error && <p className={server.state === 'disabled' ? '' : 'skill-error'}>{server.error}</p>}
          {server.tools.length > 0 && <details className="mcp-tools"><summary>查看工具</summary><ul>{server.tools.map(tool => <li key={tool.name}><code>{tool.name}</code>{tool.description && <span>{tool.description}</span>}</li>)}</ul></details>}
        </div>
        {server.state === 'unreachable' && <div className="skill-controls"><button type="button" disabled={busy} onClick={() => { void run(async () => { await api('mcp/reconnect', { name: server.name }); return `已重新连接 ${server.name}。`; }); }}>重新连接</button></div>}
      </article>)}
    </section>}
    {form && <div className="studio-dialog" role="dialog" aria-label={form.originalName ? `编辑 MCP 服务 ${form.originalName}` : '添加 MCP 服务'}><form onSubmit={event => { event.preventDefault(); void save(); }}>
      <h2>{form.originalName ? `编辑 ${form.originalName}` : '添加 MCP 服务'}</h2>
      <fieldset disabled={busy}>
        <label>名称<input aria-label="MCP 服务名称" required autoFocus value={form.name} placeholder="例如 materials" pattern="[A-Za-z0-9_\-]{1,32}" onChange={event => patch({ name: event.target.value })} /><small>字母、数字、- 和 _。工具在对话里显示为“名称 · 工具名”。</small></label>
        <label>地址<input aria-label="MCP 服务地址" required type="url" value={form.url} placeholder="例如 http://<服务器地址>:8765/mcp" onChange={event => patch({ url: event.target.value })} /><small>服务说明里写的 Streamable HTTP 地址，通常以 /mcp 结尾。</small></label>
        <div className="mcp-headers"><span>请求头（可选，例如 Authorization）</span>
          {form.headers.map((row, index) => <div key={index} className="mcp-header-row">
            <input aria-label={`请求头 ${index + 1} 名称`} value={row.name} placeholder="Authorization" onChange={event => patch({ headers: form.headers.map((item, position) => position === index ? { ...item, name: event.target.value } : item) })} />
            <input aria-label={`请求头 ${index + 1} 值`} type="password" autoComplete="new-password" value={row.value} placeholder={row.saved ? '已保存，留空不变' : 'Bearer …'} onChange={event => patch({ headers: form.headers.map((item, position) => position === index ? { ...item, value: event.target.value } : item) })} />
            <button type="button" aria-label={`删除请求头 ${index + 1}`} onClick={() => patch({ headers: form.headers.filter((_item, position) => position !== index) })}>×</button>
          </div>)}
          <button type="button" className="mcp-add-header" onClick={() => patch({ headers: [...form.headers, { name: '', value: '', saved: false }] })}>添加请求头</button>
        </div>
        <label>备注（可选）<input aria-label="MCP 服务备注" value={form.note} placeholder="例如：材料数据库，由信息部维护" onChange={event => patch({ note: event.target.value })} /></label>
        {check && <p className={`mcp-check${check.busy ? '' : check.ok ? ' is-ok' : ' is-failed'}`} role="status">{check.busy ? '正在连接…' : check.ok ? `连接成功，提供 ${check.tools.length} 个工具${check.tools.length ? `：${check.tools.slice(0, 8).map(tool => tool.name).join('、')}${check.tools.length > 8 ? ' 等' : ''}` : ''}` : `连接失败：${check.error}`}</p>}
        <div role="status">{formError}</div>
        <div><button type="button" disabled={!form.url.trim() || check?.busy} onClick={() => { void test(); }}>测试连接</button><button type="submit">保存</button><button type="button" onClick={() => setForm(undefined)}>取消</button></div>
      </fieldset>
    </form></div>}
  </section>;
}
