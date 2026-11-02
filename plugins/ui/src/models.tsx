import { useState } from 'react';
import { api } from './api.ts';
import { WebSettings } from './web-settings.tsx';
import { SandboxSettings } from './sandbox-settings.tsx';
import { AutonomySettingsSection } from './autonomy-settings.tsx';

export interface ModelProvider {
  id: string; name: string; protocol: string; baseURL: string; revision: number;
  models: { id: string; contextWindow?: number; maxTokens?: number; supportsImages?: boolean }[];
  credentialConfigured: boolean; credentialWritable: boolean; credentialSource?: string;
}
export interface ModelSettings {
  providers: ModelProvider[]; customRevision: number; protocols: string[];
}
interface Form {
  id: string; name: string; protocol: string; baseURL: string; models: string;
  contextWindow: number; maxTokens: number; apiKey: string; revision: number; isNew: boolean; visionModels: string[];
}
const protocolNames: Record<string, string> = {
  'deepseek-messages': 'DeepSeek 官方 Messages', 'openai-completions': 'OpenAI 兼容 Chat Completions',
  'openai-responses': 'OpenAI Responses', 'anthropic-messages': 'Anthropic Messages',
};
function edit(provider: ModelProvider): Form {
  return { ...provider, models: provider.models.map(model => model.id).join('\n'),
    contextWindow: provider.models[0]?.contextWindow ?? 65536, maxTokens: provider.models[0]?.maxTokens ?? 4096,
    apiKey: '', isNew: false, visionModels: provider.models.filter(model => model.supportsImages).map(model => model.id) };
}

export function ModelSettingsPage({ value, onChange }: { value: ModelSettings; onChange: (next: ModelSettings) => Promise<void> }) {
  const [form, setForm] = useState<Form>(() => edit(value.providers[0]!));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const current = value.providers.find(provider => provider.id === form.id);
  const modelNames = [...new Set(form.models.split(/\r?\n/).map(id => id.trim()).filter(Boolean))];
  const patch = (fields: Partial<Form>) => setForm(previous => ({ ...previous, ...fields }));
  const operation = async (run: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await run(); } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(false); }
  };
  return <section className="model-settings" aria-label="模型配置页面">
    <header><div><h2>模型配置</h2><p>Provider 保存到后台并即时生效；API Key 不会回显。保存不发起模型请求。</p><p>使用哪个模型，在对话输入框右下角选择。</p></div>
      <button disabled={busy} onClick={() => { setMessage(''); setForm({ id: '', name: '', protocol: 'openai-completions', baseURL: '',
        models: '', visionModels: [], contextWindow: 65536, maxTokens: 4096, apiKey: '', revision: value.customRevision, isNew: true }); }}>新增 Provider</button></header>
    <div role="status" className="model-status">{message}</div>
    <div className="model-columns">
      <nav aria-label="已保存 Provider">{value.providers.map(provider => <button key={provider.id} aria-pressed={!form.isNew && provider.id === form.id}
        disabled={busy} onClick={() => { setForm(edit(provider)); setMessage(''); }}>
        <strong>{provider.name}</strong><small>{provider.id}</small><small>{provider.credentialConfigured ? 'API Key 已配置' : 'API Key 未配置'}</small>
      </button>)}</nav>
      <form onSubmit={event => { event.preventDefault(); void operation(async () => {
        const { visionModels, ...fields } = form;
        const next = await api<ModelSettings>('models', { ...fields, models: modelNames,
          visionModels: visionModels.filter(id => modelNames.includes(id)),
          apiKey: form.apiKey || undefined });
        // Clear secret input as soon as the write succeeds; retain it only for an explicit retry on failure.
        setForm(edit(next.providers.find(provider => provider.id === form.id)!));
        await onChange(next); setMessage('Provider 已保存；后台配置已生效。');
      }); }}>
        <fieldset disabled={busy}>
          <label>Provider 标识<input aria-label="Provider 标识" required value={form.id} disabled={!form.isNew}
            placeholder="例如 company-gateway" pattern="[a-z][a-z0-9-]{1,63}" onChange={event => patch({ id: event.target.value })} /></label>
          <label>显示名称<input aria-label="Provider 显示名称" required value={form.name} disabled={form.id === 'deepseek-official'} onChange={event => patch({ name: event.target.value })} /></label>
          <label>协议<select aria-label="Provider 协议" value={form.protocol} disabled={!form.isNew && form.id === 'deepseek-official'} onChange={event => patch({ protocol: event.target.value })}>
            {value.protocols.filter(protocol => form.id === 'deepseek-official' ? protocol === 'deepseek-messages' : protocol !== 'deepseek-messages').map(protocol => <option key={protocol} value={protocol}>{protocolNames[protocol] ?? protocol}</option>)}
          </select></label>
          <label>API Base URL<input aria-label="Provider API 地址" required type="url" placeholder="https://gateway.example.com/v1" value={form.baseURL} onChange={event => patch({ baseURL: event.target.value })} /></label>
          <label>API Key<input aria-label="Provider API Key" type="password" autoComplete="new-password" value={form.apiKey}
            disabled={!!current && !current.credentialWritable} placeholder={current?.credentialConfigured ? '已配置；留空保留，填写则替换' : '留空可先保存配置'} onChange={event => patch({ apiKey: event.target.value })} /></label>
          <small>{current?.credentialSource === 'env' ? '该 Key 由启动环境提供。' : 'Key 由后台凭据服务保存，不放入浏览器本地存储。'}</small>
          <label>模型名称（每行一个）<textarea aria-label="Provider 模型列表" required value={form.models} onChange={event => patch({ models: event.target.value })} /></label>
          {modelNames.length > 0 && <section className="model-image-capabilities" aria-label="模型图片能力"><strong>图片输入</strong><p>按提供方的实际能力勾选。支持图片的模型可以接收草图、设计图和 PDF 页面；保存配置不会探测远端能力。</p>{modelNames.map(id => <label key={id}><span>{id}</span><span><input type="checkbox" aria-label={`${id} 支持图片输入`} checked={form.visionModels.includes(id)} onChange={event => patch({ visionModels: event.target.checked ? [...form.visionModels, id] : form.visionModels.filter(value => value !== id) })} />支持图片</span></label>)}</section>}
          <div className="model-capacities">
            <label>上下文容量（tokens）<input aria-label="模型上下文容量" type="number" min="1" max="10000000" required value={form.contextWindow} onChange={event => patch({ contextWindow: Number(event.target.value) })} /></label>
            <label>输出上限（tokens）<input aria-label="模型输出上限" type="number" min="1" max={form.contextWindow} required value={form.maxTokens} onChange={event => patch({ maxTokens: Number(event.target.value) })} /></label>
          </div>
          <small>按提供方能力填写，当前容量设置应用于此列表中的所有模型。</small>
          <div className="model-actions"><button type="submit">保存 Provider</button><button type="button" onClick={() => { void operation(async () => {
            const next = await api<ModelSettings>('models'); await onChange(next);
            const selected = next.providers.find(provider => provider.id === form.id); if (selected) setForm(edit(selected));
            else setForm(previous => ({ ...previous, revision: next.customRevision }));
            setMessage('已刷新后台配置。');
          }); }}>刷新配置</button></div>
        </fieldset>
      </form>
    </div>
    <WebSettings refreshKey={JSON.stringify(value.providers.map(provider => [provider.id, provider.revision, provider.credentialConfigured]))} />
    <SandboxSettings />
    <AutonomySettingsSection />
  </section>;
}
