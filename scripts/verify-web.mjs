import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { root } from './prepare.mjs';
import { startApp, stopApp, finishedChat } from './verify-app.mjs';
import { emptyChatState, foldChatPacket, conversationRows, webActivities } from '../plugins/ui/lib/chat-state.js';

await mkdir(join(root, '.studio'), { recursive: true });
const home = await mkdtemp(join(root, '.studio/web-test-'));
let app;
const fixtureTasks = 'm1-gear';
// GET /api/studio/status lists the process-wide tool registry (ctx.tools.schemas()) of this smoke home with the Mock
// software backend and no sandbox service: every tool a loaded plugin registered, not the tools one conversation's
// model sees. Each conversation then masks this registry by its kind and role; that masking is tested in
// tests/project-chat-tools.test.mjs (seat tools of project and task conversations) and tests/autonomy.test.mjs
// (autonomy and goal tools only in their role of an unfinished run). Update this list when a plugin registers a new
// tool: it guards against tools appearing without anyone noticing, not against what a model is offered.
const expectedTools = ['ask_user_question', 'studio_list_project_files', 'studio_read_checklist', 'studio_update_checklist', 'studio_graph_context', 'studio_apply_graph_patch', 'studio_browser_read', 'studio_retrieve_context', 'studio_project_context', 'studio_create_task', 'studio_task_context', 'studio_read_file', 'studio_read_project_file', 'studio_write_file', 'studio_delete_file', 'web_search', 'web_fetch',
  'studio_download_temp_file', 'studio_extract_temp_zip', 'studio_write_temp_file', 'studio_read_temp_file', 'studio_search_temp_file', 'studio_list_temp_files', 'studio_software_cancel', 'studio_software_catalog', 'studio_software_control', 'studio_software_invoke', 'studio_software_launch', 'studio_software_operation', 'studio_software_save_artifact', 'studio_software_status',
  // Skills (skills.ts), and DSH goals (dsh-tool-goal), which only autonomy orchestrators are offered.
  'skill', 'studio_skill_files', 'create_goal', 'get_goal', 'update_goal',
  // Autonomy runs (autonomy.ts): orchestrator and worker tools, and the Agent's completion with evidence.
  'studio_autonomy_start_worker', 'studio_autonomy_message_worker', 'studio_autonomy_stop_worker', 'studio_autonomy_status', 'studio_autonomy_wait',
  'studio_agent_report', 'studio_agent_completion_preview', 'studio_agent_complete_task'];
const text = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('') : '';
const query = (id, path, offset = 0, limit = 6000) => `chat/temp/file?${new URLSearchParams({ id, path, offset: String(offset), limit: String(limit) })}`;

/** Read only the first snapshot, then close the anonymous same-origin stream. No unbounded SSE wait. */
async function snapshot(id) {
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 12000);
  const response = await app.call(`chat/stream?id=${encodeURIComponent(id)}`);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const aborted = new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('No web SSE snapshot received')), { once: true }));
  let buffer = '';
  try {
    while (true) {
      const row = await Promise.race([reader.read(), aborted]);
      if (row.done) throw new Error('Web SSE stream ended before snapshot');
      buffer += decoder.decode(row.value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const record = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        if (!record.startsWith('data: ')) continue;
        const packet = JSON.parse(record.slice(6));
        if (packet.type === 'error') throw new Error(packet.error);
        if (packet.type === 'snapshot') return packet;
      }
    }
  } finally { clearTimeout(timeout); await reader.cancel(); reader.releaseLock(); }
}

/** Fixtures can contain frozen directories; only relax our newly created fixture before cleanup. */
async function release(path) {
  await chmod(path, 0o700);
  for (const row of await readdir(path, { withFileTypes: true })) if (row.isDirectory() && !row.isSymbolicLink()) await release(join(path, row.name));
}

try {
  app = await startApp(home);
  const status = await app.json('status');
  assert.deepEqual([...status.tools].sort(), [...expectedTools].sort(), 'The global tool registry changed: check who is offered the new tool, then update expectedTools');
  assert.equal((await fetch(`${app.base}/api/studio/web`)).status, 200);
  assert.equal((await fetch(`${app.base}/api/studio/web`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.invalid' }, body: JSON.stringify({ baseURL: 'https://search.fixture.invalid/anthropic/v1', model: 'search-fixture', revision: 0 }) })).status, 403);
  const webConfig = await app.json('web');
  assert.equal(typeof webConfig.credentialConfigured, 'boolean');
  assert.deepEqual(Object.keys(webConfig).sort(), ['provider', 'baseURL', 'model', 'revision', 'credentialConfigured', 'maxQueries', 'maxSources', 'maxInlineTokens'].sort(), 'Search configuration should expose credential status rather than secret fields');
  assert.ok(Number.isSafeInteger(webConfig.revision));
  const searchConfigInput = { baseURL: 'https://search.fixture.invalid/anthropic/v1', model: 'search-fixture', revision: webConfig.revision };
  for (const baseURL of ['https://user:password@search.fixture.invalid/anthropic/v1', 'ftp://search.fixture.invalid/anthropic/v1', 'file:///private/search', 'javascript:alert(1)']) {
    assert.equal((await app.call('web', { ...searchConfigInput, baseURL })).status, 400, 'Only credential-free HTTP(S) search endpoints should be accepted');
  }
  assert.equal((await app.json('web')).revision, webConfig.revision, 'Rejected endpoints must not change the saved configuration');
  const savedWebConfig = await app.json('web', searchConfigInput);
  assert.equal(savedWebConfig.baseURL, searchConfigInput.baseURL); assert.equal(savedWebConfig.model, searchConfigInput.model);
  assert.equal(savedWebConfig.credentialConfigured, webConfig.credentialConfigured);
  assert.notEqual(savedWebConfig.revision, webConfig.revision);
  assert.deepEqual(await app.json('web'), savedWebConfig, 'The saved search endpoint and model should become active immediately');
  assert.equal((await app.call('web', { ...searchConfigInput, model: 'stale-write' })).status, 400, 'An old search configuration revision must not overwrite a newer value');
  assert.equal((await app.json('web')).model, searchConfigInput.model);
  assert.equal((await fetch(`${app.base}/api/studio/chat/temp?id=unknown`)).status, 400);
  assert.equal((await fetch(`${app.base}/api/studio/chat/temp/file?id=unknown&path=scratch.txt`)).status, 400);
  assert.equal((await fetch(`${app.base}/api/studio/chat/temp/file`, { method: 'POST', headers: { 'content-type': 'application/json', origin: app.base }, body: JSON.stringify({ id: 'unknown', path: 'scratch.txt', content: 'bad' }) })).status, 400);
  assert.equal((await app.call('chat/temp?id=unknown')).status, 400);
  assert.equal((await app.call('chat/temp/file', { id: 'unknown', path: 'scratch.txt', content: 'bad' })).status, 400);

  const first = await app.json('chat', { taskId: fixtureTasks, provider: 'studio-smoke', model: 'm1-smoke', message: '[web-ui] Controlled source and spill verification' });
  const settled = await finishedChat(app, first.id);
  const calls = settled.events.filter(event => event.type === 'tool/call'), results = settled.events.filter(event => event.type === 'tool/result');
  assert.deepEqual(calls.map(event => event.data.name), ['web_search', 'web_fetch', 'studio_write_temp_file', 'studio_read_temp_file']);
  assert.equal(results.length, 4); assert.ok(results.every(event => !event.data.message.isError), 'Every controlled native tool should succeed');
  const resultFor = name => {
    const call = calls.find(event => event.data.name === name);
    const result = results.find(event => event.data.message.source.callId === call.data.callId);
    assert.ok(result, `Missing persisted result for ${name}`); return result;
  };
  const search = resultFor('web_search'), fetched = resultFor('web_fetch');
  assert.deepEqual(search.data.meta.sources.map(source => source.url), ['https://fixture.invalid/shared', 'https://fixture.invalid/gear', 'https://fixture.invalid/bearing']);
  assert.equal(search.data.meta.truncated, false);
  assert.equal(search.data.meta.sources[0].publishedAt, '2026-10-09');
  assert.deepEqual(fetched.data.meta, { url: 'https://fixture.invalid/gear', statusCode: 200, truncated: false });
  assert.equal(JSON.parse(text(resultFor('studio_read_temp_file').data.message.content)).content, 'only-this-chat');
  assert.ok(settled.events.some(event => event.type === 'assistant/message' && text(event.data.message.content).includes('Native tool schemas verified.')));
  assert.ok(settled.events.some(event => event.type === 'assistant/message' && text(event.data.message.content).includes('[齿轮测试来源](https://fixture.invalid/gear)')));

  const files = await app.json(`chat/temp?id=${first.id}`);
  assert.equal(files.files.length, 3, 'Search and fetch each archive one file; native spill and web archive must share the fetch file');
  assert.equal(files.truncated, false);
  const spill = files.files.find(file => file.path.startsWith('results/web_fetch') && file.bytes > 50000);
  assert.ok(spill, 'Oversized web_fetch output should be retained in this chat temporary directory');
  const preview = text(fetched.data.message.content);
  assert.match(preview, /Full formatted result stored at:/, 'The native DSH spill policy should retain a recoverable bounded preview');
  assert.ok(preview.includes(spill.path)); assert.ok(preview.includes('studio_read_temp_file'));
  let recovered = '', offset = 0, pages = 0;
  while (true) {
    const page = await app.json(query(first.id, spill.path, offset, 6000));
    assert.equal(page.offset, offset); assert.ok(Array.from(page.content).length <= 6000);
    recovered += page.content; pages++;
    if (page.nextOffset === undefined) { assert.equal(Array.from(recovered).length, page.totalChars); break; }
    assert.ok(page.nextOffset > offset); offset = page.nextOffset;
    assert.ok(pages < 40, 'Controlled web fixture should require fewer than 40 pages');
  }
  assert.ok(pages > 1); assert.ok(preview.length < recovered.length);
  assert.match(recovered, /STUDIO-WEB-FIXTURE/); assert.match(recovered, /Fixture paragraph 1200:/); assert.match(recovered, /END-STUDIO-WEB-FIXTURE/);
  assert.ok(recovered.length < 200000, 'Test should trigger token spilling without fetch character truncation');

  const packet = await snapshot(first.id);
  const publicResults = packet.chat.events.filter(event => event.type === 'tool/result');
  assert.deepEqual(publicResults.find(event => event.data.message.callId === search.data.message.source.callId).data.message.meta, search.data.meta);
  assert.deepEqual(publicResults.find(event => event.data.message.callId === fetched.data.message.source.callId).data.message.meta, fetched.data.meta);
  const state = foldChatPacket(emptyChatState(), packet), evidence = conversationRows(state).filter(row => row.role === 'assistant').flatMap(row => webActivities(row.steps));
  assert.equal(evidence.length, 2); assert.equal(evidence[0].sources.length, 3); assert.equal(evidence[1].statusCode, 200);

  // Two chats under one task deliberately use the same filename and retain independent contents.
  const second = await app.json('chat', { taskId: fixtureTasks, provider: 'studio-smoke', model: 'm1-smoke', message: '[web-ui] Independent conversation temp verification' });
  await finishedChat(app, second.id); assert.notEqual(first.id, second.id); assert.notEqual(first.tempDirectory, second.tempDirectory);
  await app.json('chat/temp/file', { id: second.id, path: 'scratch.txt', content: 'second-chat-content' });
  assert.equal((await app.json(query(first.id, 'scratch.txt'))).content, 'only-this-chat');
  assert.equal((await app.json(query(second.id, 'scratch.txt'))).content, 'second-chat-content');
  for (const path of [`../${first.id}/scratch.txt`, `/private/scratch.txt`, `.chat-tmp/${first.id}/scratch.txt`, '..\\scratch.txt']) {
    assert.equal((await app.call(query(second.id, path))).status, 400, `Cross-chat/temp traversal must reject ${path}`);
    assert.equal((await app.call('chat/temp/file', { id: second.id, path, content: 'bad' })).status, 400);
  }
  assert.equal((await app.call(`file?${new URLSearchParams({ taskId: fixtureTasks, path: `.chat-tmp/${first.id}/scratch.txt` })}`)).status, 400, 'Ordinary task files must not bypass private chat access');
  assert.equal((await app.call(query(first.id, 'scratch.txt', -1, 20))).status, 400);
  assert.equal((await app.call(query(first.id, 'scratch.txt', 0, 12001))).status, 400);

  await stopApp(app.child); app = undefined;
  app = await startApp(home);
  const restoredWebConfig = await app.json('web');
  assert.equal(restoredWebConfig.baseURL, searchConfigInput.baseURL); assert.equal(restoredWebConfig.model, searchConfigInput.model);
  assert.equal(restoredWebConfig.credentialConfigured, savedWebConfig.credentialConfigured);
  assert.deepEqual(Object.keys(restoredWebConfig).sort(), Object.keys(webConfig).sort(), 'Restarted search configuration must continue to redact secrets');
  assert.equal((await app.json(query(first.id, 'scratch.txt'))).content, 'only-this-chat');
  assert.equal((await app.json(query(second.id, 'scratch.txt'))).content, 'second-chat-content');
  assert.deepEqual((await app.json(`chat/temp?id=${first.id}`)).files.map(file => ({ path: file.path, bytes: file.bytes })), files.files.map(file => ({ path: file.path, bytes: file.bytes })));
  assert.equal((await app.json(query(first.id, spill.path, 0, 100))).content, Array.from(recovered).slice(0, 100).join(''));
  const restored = await snapshot(first.id);
  const restoredSearch = restored.chat.events.find(event => event.type === 'tool/result' && event.data.message.callId === search.data.message.source.callId);
  assert.deepEqual(restoredSearch.data.message.meta, search.data.meta);
  console.log('Web verification passed: anonymous same-origin and redacted search settings, endpoint validation, stale-write rejection and saved configuration recovery; native schemas and Agent tool loop, controlled multi-query deduplication, source metadata replay, native spill with paginated recovery, anonymous same-origin private temp API, same-task conversation isolation, traversal rejection and restart persistence. No external network or engineering result validated.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  if (app) await stopApp(app.child);
  await release(home); await rm(home, { recursive: true, force: true });
}
