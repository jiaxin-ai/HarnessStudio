import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '@harnessstudio/studio/domain-types';
import type { SoftwareDescriptor } from '@harnessstudio/studio/seat-types';
import type { SkillLibraryView, SkillLocation, SkillRunsIn, SkillScope, StudioSkill } from '@harnessstudio/studio/skills';
import { api } from './api.ts';
import { useNoSoftware } from './software-backend.ts';
import { droppedEntries, droppedItems, pickedItems, type UploadItem } from './task-file-actions.tsx';

type DetailScope = SkillScope | 'plugin';
interface Detail { scope: DetailScope; skill: StudioSkill; files: { path: string; bytes: number }[]; content?: string }
interface Editor { scope: SkillScope; folder?: string; name: string; description: string; body: string; raw?: string; location: SkillLocation }
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
const yamlText = (value: string) => JSON.stringify(value.trim().replace(/\s+/g, ' '));
const query = (scope: SkillScope, projectId: string): Record<string, string> => scope === 'project' ? { scope, projectId } : { scope };
export async function base64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
/** The switch moves at once; the reload after saving confirms it. */
const flip = (view: SkillLibraryView, scope: SkillScope, folder: string, enabled: boolean): SkillLibraryView => {
  const rows = (skills: StudioSkill[]) => skills.map(skill => skill.folder === folder ? { ...skill, enabled } : skill);
  return scope === 'global' ? { ...view, global: rows(view.global) } : view.project ? { ...view, project: { ...view.project, skills: rows(view.project.skills) } } : view;
};
/** Upload answers 409 for a same-name skill, so the page can ask before replacing it. */
async function upload(body: object): Promise<{ skill?: StudioSkill; exists?: string }> {
  const response = await fetch('/api/studio/skills/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (response.status === 409 && value.exists) return { exists: value.error };
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : `HTTP ${response.status}`);
  return { skill: value };
}

/** Software environments of the VM platform, by ID; `known` is false where the deployment has no VM platform to check against. */
export interface Environments { known: boolean; names: Map<string, string> }
let environmentsLoad: Promise<Environments> | undefined;
export function useEnvironments(): Environments {
  const [value, setValue] = useState<Environments>({ known: false, names: new Map() });
  // Without software there is no environment catalog to ask for.
  const noSoftware = useNoSoftware();
  useEffect(() => {
    if (noSoftware) return;
    environmentsLoad ??= api<{ images: SoftwareDescriptor[] }>('software/catalog', undefined, { timeoutMs: 30000 })
      .then(catalog => { const images = catalog.images.filter(image => image.vm); return { known: images.length > 0, names: new Map(images.map(image => [image.id, image.vm!.software.map(item => `${item.name} ${item.version}`).join(' + ')])) }; })
      .catch(() => { environmentsLoad = undefined; return { known: false, names: new Map<string, string>() }; });
    let alive = true;
    void environmentsLoad.then(next => { if (alive) setValue(next); });
    return () => { alive = false; };
  }, [noSoftware]);
  return value;
}
/** Whether sandbox skills can run now: the deployment has the sandbox and the settings page has it on. Refreshed every 10 s. */
let sandboxLoad: { at: number; value: Promise<string | undefined> } | undefined;
function useSandboxWarning(active: boolean): string | undefined {
  const [value, setValue] = useState<string>();
  useEffect(() => {
    if (!active) return;
    if (!sandboxLoad || Date.now() - sandboxLoad.at > 10000) sandboxLoad = { at: Date.now(), value: api<{ configured: boolean; enabled: boolean }>('sandbox', undefined, { timeoutMs: 15000 })
      .then(state => !state.configured ? '本部署没有安装 Linux 沙箱，暂时不能运行' : !state.enabled ? 'Linux 沙箱已在设置里关闭，暂时不能运行' : undefined, () => undefined) };
    let alive = true;
    void sandboxLoad.value.then(next => { if (alive) setValue(next); });
    return () => { alive = false; };
  }, [active]);
  return value;
}
const runsInNames: Record<SkillRunsIn, string> = { platform: '平台', sandbox: '沙箱', vm: '虚拟机' };
const environmentName = (environments: Environments, id: string) => environments.names.get(id) ?? id;
/** Where a skill runs, and what keeps it from running there. */
export function SkillLocationLine({ skill, scope, environments }: { skill: StudioSkill; scope: DetailScope; environments: Environments }) {
  const sandboxWarning = useSandboxWarning(skill.runsIn === 'sandbox'), noSoftware = useNoSoftware();
  if (skill.error) return null;
  const warnings: string[] = [];
  if (skill.runsIn === 'sandbox' && sandboxWarning) warnings.push(sandboxWarning);
  if (skill.runsIn === 'vm' && noSoftware) return <div className="skill-location-line">
    <span className="skill-location is-vm" title={skill.environments.join('、')}>要用工程软件{skill.environments.length ? ` · ${skill.environments.join(' 或 ')}` : ''}</span>
    <span className="skill-warning">这个部署没有接入软件，这个技能不能运行</span>
  </div>;
  if (skill.runsIn === 'vm' && scope === 'global') warnings.push('虚拟机看不到全局技能，请放到项目技能');
  if (skill.runsIn === 'vm' && scope === 'plugin') warnings.push('虚拟机看不到插件里的技能，要在虚拟机里运行请放到项目技能');
  if (skill.runsIn === 'vm' && environments.known) for (const id of skill.environments) if (!environments.names.has(id)) warnings.push(`虚拟机平台没有环境 ${id}`);
  const needs = skill.runsIn !== 'vm' ? '' : skill.environments.length ? ` · 需要 ${skill.environments.map(id => environmentName(environments, id)).join(' 或 ')} 的虚拟机` : ' · 任意环境的虚拟机';
  return <div className="skill-location-line">
    <span className={`skill-location is-${skill.runsIn}`} title={skill.environments.join('、')}>{runsInNames[skill.runsIn]}{needs}</span>
    {warnings.map(text => <span key={text} className="skill-warning">{text}</span>)}
  </div>;
}

/** The run-location choice of the skill editor; environments come from the VM platform when it has any. */
function LocationPicker({ value, environments, onChange }: { value: SkillLocation; environments: Environments; onChange(next: SkillLocation): void }) {
  // Without software only a skill already marked for a VM keeps that choice, so it can be moved to the sandbox or Studio.
  const noSoftware = useNoSoftware(), choices = noSoftware && value.runsIn !== 'vm' ? (['platform', 'sandbox'] as const) : (['platform', 'sandbox', 'vm'] as const);
  const [typed, setTyped] = useState(value.environments.join(', '));
  useEffect(() => { setTyped(value.environments.join(', ')); }, [value.environments]);
  const ids = [...new Set([...environments.names.keys(), ...value.environments])];
  return <fieldset className="skill-location-picker">
    <legend>运行位置</legend>
    <div className="skill-location-options">
      {choices.map(runsIn => <label key={runsIn}><input type="radio" name="skill-runs-in" aria-label={`运行位置：${runsInNames[runsIn]}`} checked={value.runsIn === runsIn}
        onChange={() => onChange({ runsIn, environments: runsIn === 'vm' ? value.environments : [] })} />{runsInNames[runsIn]}
        <small>{noSoftware ? (runsIn === 'platform' ? '用 Studio 自己的工具' : runsIn === 'sandbox' ? '在 Linux 沙箱里跑脚本' : '要用工程软件；这个部署没有接入软件，不能运行') : runsIn === 'platform' ? '用 Studio 自己的工具，不需要虚拟机' : runsIn === 'sandbox' ? '在 Linux 沙箱里跑脚本（还没上线）' : '要用工程软件，在 Windows 虚拟机里运行'}</small></label>)}
    </div>
    {value.runsIn === 'vm' && !noSoftware && (environments.known ? <div className="skill-location-environments" role="group" aria-label="需要的软件环境">
      <span>需要的软件环境（不选表示任意环境）</span>
      {ids.map(id => <label key={id}><input type="checkbox" aria-label={`环境 ${id}`} checked={value.environments.includes(id)}
        onChange={event => onChange({ runsIn: 'vm', environments: event.target.checked ? [...value.environments, id] : value.environments.filter(item => item !== id) })} />
        {environmentName(environments, id)}<code>{id}</code>{!environments.names.has(id) && <small className="skill-warning">虚拟机平台没有这个环境</small>}</label>)}
    </div> : <label className="skill-location-typed">需要的软件环境（多个用逗号分开，不填表示任意环境）<input aria-label="需要的软件环境" value={typed} placeholder="例如 win11-autocad2026"
      onChange={event => setTyped(event.target.value)} onBlur={() => onChange({ runsIn: 'vm', environments: typed.split(/[,，\s]+/).map(item => item.trim()).filter(Boolean) })} /></label>)}
    {!noSoftware && <small>虚拟机技能的脚本要放在项目技能里（虚拟机里是 F:\skills），Agent 会在本对话对应环境的虚拟机里运行它。</small>}
  </fieldset>;
}
const locationYaml = (location: SkillLocation) => location.runsIn === 'platform' ? '' : `metadata:\n  runs-in: ${location.runsIn}\n${location.runsIn === 'vm' && location.environments.length ? `  environments: [${location.environments.join(', ')}]\n` : ''}`;

/** One page for the Agent's skills: the global library, the selected project's F:\skills, and the skills installed plugins bring. */
export function SkillsPage({ projects, projectId: initialProject, onPlugins }: { projects: Project[]; projectId: string; onPlugins?(): void }) {
  const [scope, setScope] = useState<SkillScope>('global'), [projectId, setProjectId] = useState(initialProject || projects[0]?.id || '');
  const noSoftware = useNoSoftware();
  const [view, setView] = useState<SkillLibraryView>(), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Detail>(), [editor, setEditor] = useState<Editor>(), [replace, setReplace] = useState<{ text: string; body: object }>();
  const [dragging, setDragging] = useState(false);
  const environments = useEnvironments();
  const folderInput = useRef<HTMLInputElement>(null), fileInput = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => { setView(await api<SkillLibraryView>(`skills?${new URLSearchParams(projectId ? { projectId } : {})}`)); }, [projectId]);
  useEffect(() => { setView(undefined); setDetail(undefined); void load().catch(error => setMessage(error instanceof Error ? error.message : '技能读取失败')); }, [load]);
  const run = async (action: () => Promise<string | void>) => {
    setBusy(true); setMessage('');
    try { const done = await action(); await load(); if (done) setMessage(done); }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const projectAvailable = view?.project?.available ?? false;
  const skills = scope === 'global' ? view?.global ?? [] : view?.project?.skills ?? [];
  const writable = scope === 'global' || projectAvailable;
  const send = (body: object) => run(async () => {
    const result = await upload(body);
    if (result.exists) { setReplace({ text: result.exists, body: { ...body, overwrite: true } }); return; }
    return `已添加技能 ${result.skill!.name}。之后新发的消息里 Agent 就能用到它。`;
  });
  const sendItems = async (items: UploadItem[]) => {
    if (!items.length) return;
    const zip = items.length === 1 && /\.zip$/i.test(items[0]!.path);
    if (items.reduce((sum, item) => sum + item.file.size, 0) > 20 * 1024 * 1024) { setMessage('一个技能最多 20 MB'); return; }
    await send(zip ? { ...query(scope, projectId), zip: await base64(items[0]!.file) }
      : { ...query(scope, projectId), files: await Promise.all(items.map(async item => ({ path: item.path, data: await base64(item.file) }))) });
  };
  const open = (skill: StudioSkill, from: DetailScope = scope) => run(async () => {
    const params: Record<string, string> = from === 'plugin' ? { scope: 'plugin', plugin: skill.plugin!, folder: skill.folder } : { ...query(from, projectId), folder: skill.folder };
    const value = await api<{ files: { path: string; bytes: number }[]; skill: { content?: string } }>(`skills/file?${new URLSearchParams(params)}`);
    setDetail({ scope: from, skill, files: value.files, ...(value.skill.content !== undefined ? { content: value.skill.content } : {}) });
  });
  const edit = (skill: StudioSkill) => run(async () => {
    const value = await api<{ skill: { content?: string } }>(`skills/file?${new URLSearchParams({ ...query(scope, projectId), folder: skill.folder })}`);
    setEditor({ scope, folder: skill.folder, name: skill.name, description: skill.description, body: '', raw: value.skill.content ?? '', location: { runsIn: skill.runsIn, environments: skill.environments } });
  });
  const save = (value: Editor) => run(async () => {
    const content = value.raw ?? `---\nname: ${value.name.trim()}\ndescription: ${yamlText(value.description)}\n${locationYaml(value.location)}---\n\n${value.body.trim()}\n`;
    const skill = await api<StudioSkill>('skills/save', { ...query(value.scope, projectId), content, ...(value.folder ? { folder: value.folder } : {}) });
    setEditor(undefined); if (detail?.skill.folder === value.folder) setDetail(undefined);
    return value.folder ? `已保存 ${skill.name}。` : `已新建技能 ${skill.name}。之后新发的消息里 Agent 就能用到它。`;
  });
  /** In the SKILL.md editor the picker rewrites the text, and edits to the text update the picker. */
  const relocate = async (location: SkillLocation) => {
    if (!editor) return;
    // The choice shows at once; the rewritten SKILL.md text follows.
    setEditor({ ...editor, location });
    if (editor.raw === undefined) return;
    try { const value = await api<{ content: string; location: SkillLocation }>('skills/location', { content: editor.raw, ...location }); setEditor(previous => previous && { ...previous, raw: value.content, location: value.location }); }
    catch (error) { setMessage(error instanceof Error ? error.message : '运行位置无法写入'); void reread(); }
  };
  const reread = async () => {
    if (editor?.raw === undefined) return;
    try { const value = await api<{ location: SkillLocation }>('skills/location', { content: editor.raw }); setEditor(previous => previous && { ...previous, location: value.location }); } catch { /* the save reports a broken file */ }
  };
  const project = projects.find(row => row.id === projectId);
  const shadowText = (skill: StudioSkill) => skill.shadowedBy === 'project' ? ' · 本项目有同名技能，当前项目里用项目的' : skill.shadowedBy === 'global' ? ' · 有同名的全局技能，用全局的' : skill.shadowedBy === 'plugin' ? ' · 另一个插件里有同名技能，这个没有生效' : '';
  const plugins = view?.plugins ?? [];
  return <section className="skills-page" aria-label="技能页面">
    <header><div><h2>技能</h2><p>技能是写给 Agent 的说明书（SKILL.md），可以附带参考资料和脚本。Agent 平时只看到名称和简介，用到时才读全文；也可以在对话里输入 <code>/技能名</code> 让它直接按这个技能做。每个技能写明在哪里运行：{noSoftware ? '平台或沙箱' : '平台、沙箱或虚拟机'}。</p></div>
      <div className="skills-actions">
        <button type="button" disabled={busy || !writable} onClick={() => { setMessage(''); setEditor({ scope, name: '', description: '', body: '## 步骤\n\n1. \n2. \n\n## 注意\n\n- \n', location: { runsIn: 'platform', environments: [] } }); }}>新建技能</button>
        <button type="button" disabled={busy || !writable} onClick={() => folderInput.current?.click()}>上传文件夹</button>
        <button type="button" disabled={busy || !writable} onClick={() => fileInput.current?.click()}>上传 ZIP 或 .md</button>
        <input ref={folderInput} type="file" hidden aria-label="选择技能文件夹" {...{ webkitdirectory: '' }} onChange={event => { const items = pickedItems(event.target.files); event.target.value = ''; void sendItems(items); }} />
        <input ref={fileInput} type="file" hidden aria-label="选择技能 ZIP 或 SKILL.md" accept=".zip,.md" onChange={event => { const items = pickedItems(event.target.files); event.target.value = ''; void sendItems(items); }} />
      </div>
    </header>
    <nav className="skills-scopes" aria-label="技能范围">
      <button type="button" aria-pressed={scope === 'global'} onClick={() => { setScope('global'); setDetail(undefined); setMessage(''); }}>全局技能<small>{noSoftware ? '所有项目都能用' : '所有项目都能用，虚拟机里看不到'}</small></button>
      <button type="button" aria-pressed={scope === 'project'} disabled={!projects.length} onClick={() => { setScope('project'); setDetail(undefined); setMessage(''); }}>项目技能<small>只在这个项目里用，同名时优先</small></button>
      {scope === 'project' && <select aria-label="选择项目" value={projectId} onChange={event => { setProjectId(event.target.value); setMessage(''); }}>{projects.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select>}
    </nav>
    {scope === 'project' && view && <p className="skills-hint">{projectAvailable ? noSoftware ? <>放在项目公共空间的 <code>skills</code> 文件夹里，也可以在项目文件面板里直接增删。</> : <>放在项目 F 盘的 <code>skills</code> 文件夹里（虚拟机里是 <code>F:\skills</code>），也可以在项目文件面板里直接增删。要在虚拟机里运行的脚本放在这里。</> : '当前部署没有项目公共空间（F 盘），只能用全局技能。'}</p>}
    <div className="model-status" role="status">{message}</div>
    <div className={`skills-list${dragging ? ' is-dragging' : ''}`} aria-label={scope === 'global' ? '全局技能列表' : `${project?.title ?? ''} 项目技能列表`}
      onDragOver={event => { if (!writable || busy) return; event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={event => { if (!writable || busy) return; event.preventDefault(); setDragging(false); const dropped = droppedEntries(event.dataTransfer); void droppedItems(dropped).then(sendItems); }}>
      {!view ? <p className="skills-empty">正在读取技能…</p> : !skills.length ? <p className="skills-empty">{writable ? '还没有技能。点“新建技能”，或把技能文件夹拖到这里。' : '没有可用的项目技能。'}</p>
        : skills.map(skill => <article key={skill.folder} className={`skill-row${skill.enabled ? '' : ' is-disabled'}${detail?.skill.folder === skill.folder && detail.scope === scope ? ' is-selected' : ''}`}>
          <div className="skill-main">
            <strong><code>{skill.name}</code></strong>
            {skill.error ? <p className="skill-error">无法使用：{skill.error}</p> : <p>{skill.description}</p>}
            <SkillLocationLine skill={skill} scope={scope} environments={environments} />
            <small>{skill.files} 个文件 · {size(skill.bytes)}{!skill.userInvocable && !skill.error ? ' · 不能用 / 调用' : ''}{!skill.modelInvocable && !skill.error ? ' · 只在 / 调用时使用' : ''}{shadowText(skill)}</small>
          </div>
          <div className="skill-controls">
            <label className="skill-switch"><input type="checkbox" aria-label={`启用 ${skill.name}`} checked={skill.enabled} disabled={busy || !!skill.error} onChange={event => { const enabled = event.target.checked; setView(previous => previous && flip(previous, scope, skill.folder, enabled)); void run(async () => { await api('skills/toggle', { ...query(scope, projectId), name: skill.name, enabled }); return enabled ? `已启用 ${skill.name}。` : `已停用 ${skill.name}，Agent 不会再看到它。`; }); }} />{skill.enabled ? '已启用' : '已停用'}</label>
            <button type="button" disabled={busy} onClick={() => { void open(skill); }}>查看</button>
            <button type="button" disabled={busy || !writable} onClick={() => { void edit(skill); }}>编辑</button>
            <button type="button" className="skill-delete" disabled={busy || !writable} onClick={() => { if (window.confirm(`删除技能 ${skill.name}？它的整个文件夹都会删除，不能恢复。`)) void run(async () => { await api('skills/delete', { ...query(scope, projectId), folder: skill.folder }); if (detail?.skill.folder === skill.folder) setDetail(undefined); return `已删除 ${skill.name}。`; }); }}>删除</button>
          </div>
        </article>)}
    </div>
    {plugins.length > 0 && <section className="skills-plugin-group" aria-label="来自插件的技能">
      <header><h3>来自插件</h3><p>这些技能随插件安装，对所有项目生效；启用、停用和删除在{onPlugins ? <button type="button" className="skills-link" onClick={onPlugins}>插件页面</button> : '插件页面'}操作。同名时项目技能和全局技能优先。</p></header>
      {plugins.map(skill => <article key={`${skill.plugin}/${skill.folder}`} className={`skill-row${skill.enabled && !skill.shadowedBy ? '' : ' is-disabled'}${detail?.scope === 'plugin' && detail.skill.plugin === skill.plugin && detail.skill.folder === skill.folder ? ' is-selected' : ''}`}>
        <div className="skill-main">
          <strong><code>{skill.name}</code><span className="skill-plugin-name">插件 {skill.plugin}</span></strong>
          {skill.error ? <p className="skill-error">无法使用：{skill.error}</p> : <p>{skill.description}</p>}
          <SkillLocationLine skill={skill} scope="plugin" environments={environments} />
          <small>{skill.enabled ? '已启用' : '插件已停用'} · {skill.files} 个文件 · {size(skill.bytes)}{shadowText(skill)}</small>
        </div>
        <div className="skill-controls"><button type="button" disabled={busy} onClick={() => { void open(skill, 'plugin'); }}>查看</button></div>
      </article>)}
    </section>}
    {detail && <section className="skill-detail" aria-label={`技能 ${detail.skill.name} 内容`}>
      <header><strong>{detail.skill.name}</strong><button type="button" onClick={() => setDetail(undefined)}>关闭</button></header>
      <pre>{detail.content ?? '（SKILL.md 无法预览）'}</pre>
      {detail.files.length > 1 && <><h4>附带文件</h4><ul>{detail.files.map(file => <li key={file.path}><code>{file.path}</code><small>{size(file.bytes)}</small></li>)}</ul></>}
    </section>}
    {editor && <div className="studio-dialog" role="dialog" aria-label={editor.folder ? `编辑技能 ${editor.name}` : '新建技能'}><form onSubmit={event => { event.preventDefault(); void save(editor); }}>
      <h2>{editor.folder ? `编辑 ${editor.name}` : `新建${editor.scope === 'global' ? '全局' : '项目'}技能`}</h2>
      <fieldset disabled={busy}>
        {editor.raw === undefined ? <>
          <label>名称<input aria-label="技能名称" required autoFocus value={editor.name} placeholder="例如 solidworks-modeling" pattern="[a-z0-9]+(-[a-z0-9]+)*" onChange={event => setEditor({ ...editor, name: event.target.value })} /><small>小写字母、数字和连字符；对话里用 /{editor.name || '名称'} 调用。</small></label>
          <label>简介<input aria-label="技能简介" required value={editor.description} placeholder="一句话：这个技能做什么、什么时候用" onChange={event => setEditor({ ...editor, description: event.target.value })} /><small>Agent 靠这句话判断要不要用它，写清楚适用场景。</small></label>
          <LocationPicker value={editor.location} environments={environments} onChange={location => { void relocate(location); }} />
          {editor.location.runsIn === 'vm' && editor.scope === 'global' && !noSoftware && <p className="skill-warning">虚拟机看不到全局技能。要在虚拟机里运行的技能，请在“项目技能”里新建。</p>}
          <label>说明（Markdown）<textarea aria-label="技能说明" required rows={12} value={editor.body} onChange={event => setEditor({ ...editor, body: event.target.value })} /></label>
        </> : <>
          <LocationPicker value={editor.location} environments={environments} onChange={location => { void relocate(location); }} />
          {editor.location.runsIn === 'vm' && editor.scope === 'global' && !noSoftware && <p className="skill-warning">虚拟机看不到全局技能，请放到项目技能。</p>}
          <label>SKILL.md<textarea aria-label="SKILL.md 内容" required rows={18} value={editor.raw} onChange={event => setEditor({ ...editor, raw: event.target.value })} onBlur={() => { void reread(); }} /><small>开头 --- 之间的 name 和 description 必须保留；上面的运行位置会写进 metadata。</small></label>
        </>}
        <div role="status">{message}</div>
        <div><button type="submit" disabled={editor.raw === undefined && (!SKILL_NAME.test(editor.name) || !editor.description.trim() || !editor.body.trim())}>保存</button><button type="button" onClick={() => setEditor(undefined)}>取消</button></div>
      </fieldset>
    </form></div>}
    {replace && <div className="studio-dialog" role="dialog" aria-label="替换同名技能"><form onSubmit={event => { event.preventDefault(); const body = replace.body; setReplace(undefined); void send(body); }}>
      <h2>替换同名技能？</h2><p>{replace.text}。原来的文件夹会被整个替换。</p>
      <div><button type="submit">替换</button><button type="button" onClick={() => setReplace(undefined)}>取消</button></div>
    </form></div>}
  </section>;
}

interface AvailableSkill { name: string; description: string; scope: DetailScope; userInvocable: boolean; runsIn: SkillRunsIn; plugin?: string }
/** Composer button: the skills this chat's Agent can use; picking one starts the message with /name. */
export function ChatSkillPicker({ projectId, disabled, onPick }: { projectId?: string; disabled: boolean; onPick(name: string): void }) {
  const [open, setOpen] = useState(false), [skills, setSkills] = useState<AvailableSkill[]>(), [error, setError] = useState('');
  const panel = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open || !projectId) return;
    let alive = true; setError('');
    void api<{ skills: AvailableSkill[] }>(`skills/available?${new URLSearchParams({ projectId })}`)
      .then(value => { if (alive) setSkills(value.skills.filter(skill => skill.userInvocable)); }, reason => { if (alive) setError(reason instanceof Error ? reason.message : '技能读取失败'); });
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target) && !button.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { alive = false; document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, projectId]);
  if (!projectId) return null;
  return <div className="chat-skill-picker">
    <button ref={button} className="chat-attachment-button" type="button" disabled={disabled} aria-label="使用技能" aria-expanded={open} title="使用技能：让 Agent 按某个技能做" onClick={() => setOpen(value => !value)}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 3.5h9.5a2 2 0 0 1 2 2v11H6a2 2 0 0 1-2-2zM4 14.5a2 2 0 0 1 2-2h9.5M7.5 7h5M7.5 9.5h3" /></svg>
    </button>
    {open && <div ref={panel} className="chat-skill-menu" role="menu" aria-label="可用技能">
      <header>使用技能<small>Agent 也会自己判断何时用</small></header>
      {error ? <p className="skill-error">{error}</p> : !skills ? <p>正在读取…</p> : !skills.length ? <p>还没有技能。在左下角“技能”页面添加。</p>
        : skills.map(skill => {
          const tags = [skill.scope === 'project' ? '项目' : skill.scope === 'plugin' ? '插件' : '', skill.runsIn === 'platform' ? '' : runsInNames[skill.runsIn]].filter(Boolean);
          return <button key={skill.name} type="button" role="menuitem" onClick={() => { onPick(skill.name); setOpen(false); }}>
            <strong>/{skill.name}</strong><span>{skill.description}</span>{tags.length > 0 && <small>{tags.join(' · ')}</small>}
          </button>;
        })}
    </div>}
  </div>;
}
