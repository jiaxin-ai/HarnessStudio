import { useCallback, useEffect, useRef, useState } from 'react';
import type { PluginConfigField, PluginView } from '@harnessstudio/studio/plugins';
import type { StudioSkill } from '@harnessstudio/studio/skills';
import { api } from './api.ts';
import { useNoSoftware } from './software-backend.ts';
import { pluginMcpState } from './mcp.tsx';
import { SkillLocationLine, size, useEnvironments } from './skills.tsx';
import { droppedEntries, droppedItems, pickedItems, type UploadItem } from './task-file-actions.tsx';

const MAX_BYTES = 50 * 1024 * 1024, MAX_FILES = 2000, ZIP_MAX_BYTES = 20 * 1024 * 1024;
type Values = Record<string, string | boolean>;
/** Streams the folder or ZIP as form data; 409 means a plugin of that name exists and the page asks before replacing it. */
async function upload(form: FormData): Promise<{ plugin?: PluginView; exists?: string }> {
  const response = await fetch('/api/studio/plugins/upload', { method: 'POST', body: form });
  const value = await response.json().catch(() => ({}));
  if (response.status === 409 && value.exists) return { exists: value.error };
  if (response.status === 413) throw new Error('一个插件最多 50 MB');
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : `HTTP ${response.status}`);
  return { plugin: value };
}
const shadowText = (skill: StudioSkill) => skill.shadowedBy === 'project' ? '有同名的项目技能，那个项目里用项目的' : skill.shadowedBy === 'global' ? '有同名的全局技能，用全局的' : skill.shadowedBy === 'plugin' ? '另一个插件里有同名技能，这个没有生效' : '';
const pending = (plugin: PluginView) => plugin.config.filter(field => field.required && !field.set && field.default === undefined);

/** Plugins bundle skills and MCP servers in the Claude Code format; each is installed once and works in every project. */
export function PluginsPage() {
  const noSoftware = useNoSoftware();
  const [plugins, setPlugins] = useState<PluginView[]>(), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string>(), [dragging, setDragging] = useState(false);
  const [replace, setReplace] = useState<{ text: string; form: FormData }>(), [settings, setSettings] = useState<{ plugin: PluginView; values: Values }>();
  const [preview, setPreview] = useState<{ skill: StudioSkill; content: string }>();
  const environments = useEnvironments();
  const folderInput = useRef<HTMLInputElement>(null), zipInput = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => { setPlugins((await api<{ plugins: PluginView[] }>('plugins')).plugins); }, []);
  useEffect(() => { void load().catch(error => setMessage(error instanceof Error ? error.message : '插件读取失败')); }, [load]);
  // Folders put into plugins/ by hand appear without a reload.
  useEffect(() => { const timer = setInterval(() => { if (!busy && !document.hidden) void load().catch(() => undefined); }, 5000); return () => clearInterval(timer); }, [load, busy]);
  const run = async (action: () => Promise<string | void>) => {
    setBusy(true); setMessage('');
    try { const done = await action(); await load(); if (done) setMessage(done); }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const installed = (plugin: PluginView) => {
    const waiting = pending(plugin);
    setOpen(plugin.folder);
    return `已安装插件 ${plugin.displayName ?? plugin.name}${waiting.length ? `。还要填写设置：${waiting.map(field => field.title).join('、')}，点“设置”填写。` : '，所有项目的新消息里 Agent 就能用到它。'}`;
  };
  const send = (form: FormData) => run(async () => {
    const result = await upload(form);
    if (result.exists) { form.set('overwrite', '1'); setReplace({ text: result.exists, form }); return; }
    return installed(result.plugin!);
  });
  const sendItems = async (items: UploadItem[]) => {
    if (!items.length) return;
    if (items.length > MAX_FILES) { setMessage(`一个插件最多 ${MAX_FILES} 个文件`); return; }
    if (items.reduce((sum, item) => sum + item.file.size, 0) > MAX_BYTES) { setMessage('一个插件最多 50 MB'); return; }
    const form = new FormData();
    if (items.length === 1 && /\.zip$/i.test(items[0]!.path)) {
      if (items[0]!.file.size > ZIP_MAX_BYTES) { setMessage('ZIP 文件最多 20 MB；更大的插件请上传文件夹'); return; }
      form.append('name', items[0]!.file.name); form.append('zip', items[0]!.file);
    }
    else {
      const top = items[0]!.path.split('/')[0]!;
      if (items.every(item => item.path.startsWith(`${top}/`))) form.append('name', top);
      for (const item of items) { form.append('path', item.path); form.append('file', item.file); }
    }
    await send(form);
  };
  const toggle = (plugin: PluginView, enabled: boolean) => {
    setPlugins(previous => previous?.map(row => row.folder === plugin.folder ? { ...row, enabled } : row));
    void run(async () => { await api('plugins/toggle', { folder: plugin.folder, enabled }); return enabled ? `已启用 ${plugin.displayName ?? plugin.name}。` : `已停用 ${plugin.displayName ?? plugin.name}，Agent 不会再看到它的技能和 MCP 工具。`; });
  };
  const configure = (plugin: PluginView) => setSettings({ plugin, values: Object.fromEntries(plugin.config.map(field => [field.key, field.type === 'boolean' ? (field.value ?? field.default ?? false) as boolean : field.value === undefined ? '' : String(field.value)])) });
  const saveSettings = (value: { plugin: PluginView; values: Values }) => run(async () => {
    const values = Object.fromEntries(value.plugin.config.map(field => [field.key, field.type === 'number' && value.values[field.key] !== '' ? Number(value.values[field.key]) : value.values[field.key]]));
    await api('plugins/config', { folder: value.plugin.folder, values });
    setSettings(undefined);
    return `已保存 ${value.plugin.displayName ?? value.plugin.name} 的设置。`;
  });
  const show = (skill: StudioSkill) => run(async () => {
    const value = await api<{ skill: { content?: string } }>(`skills/file?${new URLSearchParams({ scope: 'plugin', plugin: skill.plugin!, folder: skill.folder })}`);
    setPreview({ skill, content: value.skill.content ?? '（SKILL.md 无法预览）' });
  });
  return <section className="skills-page plugins-page" aria-label="插件页面">
    <header><div><h2>插件</h2><p>插件把一组技能和 MCP 服务打包在一个文件夹里，一次安装，所有项目都能用。格式和 Claude Code 的插件一样：<code>.claude-plugin/plugin.json</code> 写名称和简介，<code>skills/</code> 放技能，<code>.mcp.json</code> 写 MCP 服务。只接入 HTTP 类 MCP 服务；Hooks、命令等其他内容暂不支持。</p></div>
      <div className="skills-actions">
        <button type="button" disabled={busy} onClick={() => folderInput.current?.click()}>上传文件夹</button>
        <button type="button" disabled={busy} onClick={() => zipInput.current?.click()}>上传 ZIP</button>
        <input ref={folderInput} type="file" hidden aria-label="选择插件文件夹" {...{ webkitdirectory: '' }} onChange={event => { const items = pickedItems(event.target.files); event.target.value = ''; void sendItems(items); }} />
        <input ref={zipInput} type="file" hidden aria-label="选择插件 ZIP" accept=".zip" onChange={event => { const items = pickedItems(event.target.files); event.target.value = ''; void sendItems(items); }} />
      </div>
    </header>
    <p className="skills-hint">也可以把插件文件夹直接放进 Studio 数据目录下的 <code>plugins</code> 文件夹，几秒内自动出现。{noSoftware ? '' : '虚拟机看不到插件里的技能，要在虚拟机里运行的脚本请放到项目技能。'}</p>
    <div className="model-status" role="status">{message}</div>
    <div className={`skills-list${dragging ? ' is-dragging' : ''}`} aria-label="插件列表"
      onDragOver={event => { if (busy) return; event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={event => { if (busy) return; event.preventDefault(); setDragging(false); const dropped = droppedEntries(event.dataTransfer); void droppedItems(dropped).then(sendItems); }}>
      {!plugins ? <p className="skills-empty">正在读取插件…</p> : !plugins.length ? <p className="skills-empty">还没有插件。点“上传文件夹”，或把插件文件夹拖到这里。</p>
        : plugins.map(plugin => {
          const title = plugin.displayName ?? plugin.name, expanded = open === plugin.folder, waiting = pending(plugin);
          const notes = [plugin.skills.length ? `${plugin.skills.length} 个技能` : '', plugin.mcp.length ? `${plugin.mcp.length} 个 MCP 服务` : '', plugin.version ? `版本 ${plugin.version}` : '', plugin.author ?? '', `${plugin.files} 个文件 · ${size(plugin.bytes)}`].filter(Boolean);
          return <div key={plugin.folder} className="plugin-item">
            <article className={`skill-row plugin-row${plugin.enabled ? '' : ' is-disabled'}${expanded ? ' is-selected' : ''}`}>
              <div className="skill-main">
                <strong>{title}{title !== plugin.name && <code className="plugin-code">{plugin.name}</code>}</strong>
                {plugin.error ? <p className="skill-error">无法使用：{plugin.error}</p> : plugin.description && <p>{plugin.description}</p>}
                <small>{notes.join(' · ')}</small>
                {!plugin.error && waiting.length > 0 && <span className="skill-warning">还要填写设置：{waiting.map(field => field.title).join('、')}</span>}
                {!plugin.error && plugin.unsupported.length > 0 && <span className="plugin-unsupported">暂不支持，已忽略：{plugin.unsupported.join('、')}</span>}
              </div>
              <div className="skill-controls">
                <label className="skill-switch"><input type="checkbox" aria-label={`启用插件 ${title}`} checked={plugin.enabled} disabled={busy || !!plugin.error} onChange={event => toggle(plugin, event.target.checked)} />{plugin.enabled ? '已启用' : '已停用'}</label>
                <button type="button" disabled={busy || !!plugin.error} aria-expanded={expanded} onClick={() => { setOpen(expanded ? undefined : plugin.folder); setPreview(undefined); }}>{expanded ? '收起' : '查看'}</button>
                {plugin.config.length > 0 && <button type="button" disabled={busy || !!plugin.error} onClick={() => configure(plugin)}>设置</button>}
                <button type="button" className="skill-delete" disabled={busy} onClick={() => { if (window.confirm(`删除插件 ${title}？它的整个文件夹（包括里面的技能）都会删除，不能恢复。`)) void run(async () => { await api('plugins/delete', { folder: plugin.folder }); if (expanded) setOpen(undefined); return `已删除插件 ${title}。`; }); }}>删除</button>
              </div>
            </article>
            {expanded && !plugin.error && <section className="plugin-detail" aria-label={`插件 ${title} 内容`}>
              <h4>技能{plugin.skills.length ? `（${plugin.skills.length}）` : ''}</h4>
              {!plugin.skills.length ? <p className="plugin-none">没有技能。</p> : <ul className="plugin-skills">{plugin.skills.map(skill => <li key={skill.folder}>
                <div><code>{skill.name}</code>{skill.error ? <span className="skill-error">无法使用：{skill.error}</span> : <span>{skill.description}</span>}</div>
                <SkillLocationLine skill={skill} scope="plugin" environments={environments} />
                {skill.shadowedBy && <small>{shadowText(skill)}</small>}
                <button type="button" disabled={busy} onClick={() => { void show(skill); }}>查看 SKILL.md</button>
              </li>)}</ul>}
              {preview && plugin.skills.some(skill => skill.folder === preview.skill.folder && skill.plugin === preview.skill.plugin) && <div className="skill-detail"><header><strong>{preview.skill.name}</strong><button type="button" onClick={() => setPreview(undefined)}>关闭</button></header><pre>{preview.content}</pre></div>}
              <h4>MCP 服务{plugin.mcp.length ? `（${plugin.mcp.length}）` : ''}</h4>
              {!plugin.mcp.length ? <p className="plugin-none">没有 MCP 服务。</p> : <ul className="plugin-servers">{plugin.mcp.map(server => <li key={server.name}>
                <div><code>{server.name}</code><span className={`mcp-state is-${server.state}`}>{pluginMcpState(server)}</span></div>
                {server.url && <small className="mcp-url" title={server.url}>{server.url}{server.headerNames.length ? ` · 请求头：${server.headerNames.join('、')}` : ''}</small>}
                {server.error && server.state !== 'disabled' && <small className="skill-error">{server.error}</small>}
                {server.tools.length > 0 && <details className="mcp-tools"><summary>查看工具</summary><ul>{server.tools.map(tool => <li key={tool.name}><code>{tool.name}</code>{tool.description && <span>{tool.description}</span>}</li>)}</ul></details>}
                {server.state === 'unreachable' && <button type="button" disabled={busy} onClick={() => { void run(async () => { await api('mcp/reconnect', { name: server.name }); return `已重新连接 ${server.name}。`; }); }}>重新连接</button>}
              </li>)}</ul>}
              {plugin.unsupported.length > 0 && <><h4>暂不支持的内容</h4><ul className="plugin-unsupported-list">{plugin.unsupported.map(item => <li key={item}>{item}</li>)}</ul></>}
            </section>}
          </div>;
        })}
    </div>
    {settings && <div className="studio-dialog" role="dialog" aria-label={`插件 ${settings.plugin.displayName ?? settings.plugin.name} 的设置`}><form onSubmit={event => { event.preventDefault(); void saveSettings(settings); }}>
      <h2>{settings.plugin.displayName ?? settings.plugin.name} 的设置</h2>
      <fieldset disabled={busy}>
        {settings.plugin.config.map((field: PluginConfigField) => <label key={field.key} className={field.type === 'boolean' ? 'plugin-config-check' : undefined}>
          {field.type === 'boolean' ? <><input type="checkbox" aria-label={field.title} checked={settings.values[field.key] === true} onChange={event => setSettings({ ...settings, values: { ...settings.values, [field.key]: event.target.checked } })} />{field.title}</> : <>
            {field.title}{field.required && <em className="plugin-required">必填</em>}
            {field.options ? <select aria-label={field.title} value={String(settings.values[field.key] ?? '')} onChange={event => setSettings({ ...settings, values: { ...settings.values, [field.key]: event.target.value } })}>
              <option value="">{field.default !== undefined ? `默认（${String(field.default)}）` : '请选择'}</option>{field.options.map(option => <option key={option} value={option}>{option}</option>)}</select>
            : <input aria-label={field.title} type={field.sensitive ? 'password' : field.type === 'number' ? 'number' : 'text'} autoComplete={field.sensitive ? 'new-password' : 'off'}
              {...(field.type === 'number' ? { min: field.min, max: field.max, step: 'any' } : {})} value={String(settings.values[field.key] ?? '')}
              placeholder={field.sensitive && field.set ? '已保存，留空不变' : field.default !== undefined ? `默认 ${String(field.default)}` : ''}
              onChange={event => setSettings({ ...settings, values: { ...settings.values, [field.key]: event.target.value } })} />}
          </>}
          {field.description && <small>{field.description}</small>}
        </label>)}
        <p className="skills-hint">密码类的值保存后不会再显示。</p>
        <div role="status">{message}</div>
        <div><button type="submit">保存</button><button type="button" onClick={() => setSettings(undefined)}>取消</button></div>
      </fieldset>
    </form></div>}
    {replace && <div className="studio-dialog" role="dialog" aria-label="替换同名插件"><form onSubmit={event => { event.preventDefault(); const form = replace.form; setReplace(undefined); void send(form); }}>
      <h2>替换同名插件？</h2><p>{replace.text}。原来的插件文件夹会被整个替换，开关和设置保留。</p>
      <div><button type="submit">替换</button><button type="button" onClick={() => setReplace(undefined)}>取消</button></div>
    </form></div>}
  </section>;
}
