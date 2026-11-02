import { useEffect, useState } from 'react';
import { api } from './api.ts';
interface SearchSettings { provider: string; baseURL: string; model: string; revision: number; credentialConfigured: boolean; maxQueries: number; maxSources: number; maxInlineTokens: number }
export function WebSettings({ refreshKey }: { refreshKey: string }) {
  const [value, setValue] = useState<SearchSettings>(), [baseURL, setBaseURL] = useState(''), [model, setModel] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => {
    let alive = true;
    void api<SearchSettings>('web').then(next => { if (alive) { setValue(next); setBaseURL(next.baseURL); setModel(next.model); } }, error => { if (alive) setMessage(String(error)); });
    return () => { alive = false; };
  }, [refreshKey]);
  return <form className="web-settings" aria-label="联网搜索配置" onSubmit={event => {
    event.preventDefault(); if (!value || busy) return; setBusy(true); setMessage('');
    void api<SearchSettings>('web', { baseURL, model, revision: value.revision }).then(next => { setValue(next); setBaseURL(next.baseURL); setModel(next.model); setMessage('搜索配置已保存，下一次检索生效。'); }, error => setMessage(error instanceof Error ? error.message : '保存失败')).finally(() => setBusy(false));
  }}>
    <div className="web-settings-heading"><h3>联网搜索</h3><span>{value?.credentialConfigured ? '凭据已配置' : '请配置 DeepSeek API Key'}</span></div>
    <p>所有对话均可调用搜索与网页读取。搜索服务复用上方 DeepSeek 官方 Provider 的 API Key，搜索模型独立于对话模型。</p>
    <fieldset disabled={busy || !value}><label>搜索 API 地址<input aria-label="搜索 API 地址" required value={baseURL} onChange={event => setBaseURL(event.target.value)} /></label>
      <label>搜索模型<input aria-label="搜索模型" required value={model} onChange={event => setModel(event.target.value)} /></label>
      <button type="submit">保存搜索配置</button></fieldset>
    <small>每次最多 4 个查询、8 个来源；长结果保存到本对话的临时目录，可分页回读。保存配置不会发起搜索请求。</small>
    {message && <div className="model-status" role="status">{message}</div>}
  </form>;
}
