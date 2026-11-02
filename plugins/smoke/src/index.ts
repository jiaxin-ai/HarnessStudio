import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type StreamChunk, type LlmModelInfo, type ToolCallId } from '@deepseek-ai/dsh-llm';
import { brandString } from '@deepseek-ai/dsh-brand';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@harnessstudio/studio';
import type {} from '@deepseek-ai/dsh-web';
import type {} from '@deepseek-ai/dsh-attachment';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { questionProbe } from './questions-probe.ts';
import { installM4Probe } from './m4-probe.ts';
import { installM5Probe, m5Probe } from './m5-probe.ts';
import { autonomyProbe } from './autonomy-probe.ts';
import { SmokeWire } from './wire.ts';

/** Present under STUDIO_SMOKE_WIRE=1: model calls and searches cross a loopback HTTP exchange (wire.ts). */
let wire: SmokeWire | undefined;

export const name = 'harnessstudio-smoke';
export const inject = ['llm', 'studio', 'studioDomain', 'connection', 'web', 'attachments', 'agents', 'agentPresets'];

/** Deterministic test provider. This is never used as an engineering model. */
class SmokeAdapter extends LlmAdapter {
  private readonly steps = new Map<string, number>();
  private readonly webSteps = new Map<string, number>();
  private readonly projectSteps = new Map<string, number>();
  private readonly taskDraftSteps = new Map<string, number>();
  private readonly taskChildSteps = new Map<string, number>();
  private readonly taskContextSteps = new Map<string, number>();
  override providerInfo(provider: string) { return { id: provider, name: 'M1 测试适配器（非真实模型）' }; }
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    // m1-smoke-1m declares the 1,000,000-token window of the production models, so window-relative policies can be tested.
    return Promise.resolve([{ provider, id: 'm1-smoke', name: 'M1 deterministic smoke' }, { provider, id: 'm1-smoke-1m', name: 'M1 deterministic smoke, 1M window' }]);
  }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: model === 'm1-smoke-1m' ? 1_000_000 : 64000 } };
  }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const chunks = this.direct(options);
    return wire ? wire.stream(options, chunks) : chunks;
  }
  private async *direct(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    // Autonomous-run chats are recognised by their script, before any per-session counter below moves.
    const autonomy = autonomyProbe(options);
    if (autonomy) { yield* autonomy; return; }
    const key = options.sessionId ?? 'auxiliary';
    const stage = this.steps.get(key) ?? 0;
    this.steps.set(key, (stage + 1) % 3);
    const scenario = JSON.stringify(options.messages);
    const currentPrompt = JSON.stringify(options.messages.filter(message => message.role === 'user' && message.source?.kind === 'user').at(-1)?.content) ?? '';
    const latestUserIndex = options.messages.findLastIndex(message => message.role === 'user' && message.source?.kind === 'user');
    const latestUser = options.messages[latestUserIndex];
    const graphPrompt = latestUser?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? '';
    const recovery = m5Probe(options, graphPrompt, latestUserIndex);
    if (recovery) { yield* recovery; return; }
    const guidedQuestions = questionProbe(options, graphPrompt, latestUserIndex);
    if (guidedQuestions) { yield* guidedQuestions; return; }
    if (/^\[software-ui\](?:\s|$)/u.test(graphPrompt)) {
      const selection = /^\[software-ui\]\s*(\{.*\})$/su.exec(graphPrompt);
      const imageId = selection ? (JSON.parse(selection[1]!) as { imageId: string }).imageId : 'mock-solidworks';
      if (!['mock-solidworks', 'mock-ansys', 'mock-autocad'].includes(imageId)) throw new Error('Software fixture requires a known explicit image');
      const simulation = imageId === 'mock-ansys';
      const names = ['studio_software_catalog', 'studio_software_status', 'studio_software_launch', 'studio_software_control', 'studio_software_invoke', 'studio_software_operation',
        ...(simulation ? ['studio_software_invoke', 'studio_software_operation'] : []), 'studio_software_invoke', 'studio_software_operation', 'studio_software_save_artifact', 'studio_software_control'];
      for (const name of names) {
        const schema = options.tools?.find(tool => tool.name === name);
        if (!schema || schema.parameters.additionalProperties !== false) throw new Error('Software fixture requires closed task-bound native schemas');
        const fields = Object.keys((schema.parameters as { properties?: Record<string, unknown> }).properties ?? {});
        if (fields.some(field => ['taskId', 'projectId', 'seatId', 'token', 'controlToken', 'url'].includes(field))) throw new Error('Software tools must not expose an arbitrary owner or service credential');
      }
      const rawResults = options.messages.slice(latestUserIndex + 1).filter(message => message.role === 'tool');
      if (rawResults.some(message => message.isError)) throw new Error('Software fixture: native Bridge tool failed');
      const decode = (index: number) => JSON.parse(rawResults[index]!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''));
      let polls = 0;
      if (rawResults.length >= 3) {
        let launched = decode(2);
        const selectedSeatId = launched.seat.id;
        if (launched.seat.softwareId !== imageId) throw new Error('Software fixture: launch returned a different image');
        while (launched.seat.state === 'provisioning' && 3 + polls < rawResults.length) {
          launched = decode(3 + polls++);
          if (launched.seat?.softwareId !== imageId || launched.seat.id !== selectedSeatId) throw new Error('Software fixture: provisioning status crossed the selected image Seat');
        }
        if (launched.seat.state === 'provisioning') {
          await setTimeout(100, undefined, { signal: options.signal });
          const call = { type: 'tool-call' as const, id: brandString<ToolCallId>(randomUUID()), name: 'studio_software_status', arguments: JSON.stringify({ imageId }) };
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'block-end', index: 0, block: call }; yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (launched.seat.state !== 'ready') throw new Error('Software fixture: selected image did not become ready');
      }
      const results = [...rawResults.slice(0, 3), ...rawResults.slice(3 + polls)];
      const value = (index: number) => JSON.parse(results[index]!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''));
      const step = results.length;
      if (step >= 2 && !value(0).images.some((image: { id: string }) => image.id === imageId)) throw new Error('Software fixture selection must exist in the advertised image catalog');
      let args: Record<string, unknown> = step >= 2 ? { imageId } : {};
      if (step === 2) args = { imageId, requestId: `smoke-launch-${key}-${imageId}` };
      if (step === 3 || step === names.length - 1) args = { imageId, action: step === 3 ? 'acquire' : 'release' };
      if (step === 4) args = { imageId, requestId: `smoke-edit-${key}-${imageId}`, capability: simulation ? 'analysis.configure' : 'shape.add',
        parameters: JSON.stringify(simulation ? { type: 'static', loadN: 120, elasticModulusMPa: 210000, meshSizeMm: 5 } : { kind: 'rectangle', x: 60, y: 80, width: 140, height: 100, label: `DSH native ${imageId} shape` }), expectedDocumentRevision: value(3).seat.document.revision };
      if (step === 5) args = { imageId, operationId: value(4).operation.id };
      if (simulation && step === 6) args = { imageId, requestId: `smoke-run-${key}-${imageId}`, capability: 'analysis.run', parameters: '{}', expectedDocumentRevision: value(5).operation.result.documentRevision };
      if (simulation && step === 7) args = { imageId, operationId: value(6).operation.id };
      const exportStep = simulation ? 8 : 6;
      if (step === exportStep) args = { imageId, requestId: `smoke-export-${key}-${imageId}`, capability: 'document.export', parameters: JSON.stringify({ format: 'json', name: `native-${imageId}.json` }), expectedDocumentRevision: value(exportStep - 1).operation.result.documentRevision };
      if (step === exportStep + 1) args = { imageId, operationId: value(exportStep).operation.id };
      if (step === exportStep + 2) args = { imageId, artifactId: value(exportStep + 1).operation.result.artifactId };
      if (step < names.length) {
        const call = { type: 'tool-call' as const, id: brandString<ToolCallId>(randomUUID()), name: names[step]!, arguments: JSON.stringify(args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'block-end', index: 0, block: call }; yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const text = 'M3 原生 Bridge 验证完成：虚拟文档已导出到任务工作区，Agent 已释放控制权。仅为 Mock 演示。';
        yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text }; yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } };
      }
      return;
    }
    // Four separate native LLM calls expose a chronological reasoning/tool/answer
    // timeline. Progress comes from durable results, including the real human
    // question response, rather than an adapter-local counter.
    if (/^\[chat-step-timeline\](?:\s|$)/u.test(graphPrompt)) {
      const required = ['web_search', 'studio_list_temp_files', 'ask_user_question'];
      if (required.some(name => !options.tools?.some(tool => tool.name === name))) throw new Error('Chat step fixture: native web, scratch and question tools must all be bound');
      const results = options.messages.slice(latestUserIndex + 1).filter(message => message.role === 'tool');
      if (results.some(message => message.isError)) throw new Error('Chat step fixture: a controlled native tool failed');
      if (results.length >= 3) {
        const value = JSON.parse(results[2]!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')) as { answers?: Array<{ id: string; selected: string[] }> };
        if (!value.answers?.some(answer => answer.id === 'timeline_continue' && answer.selected.length === 1 && answer.selected[0] === '继续演示')) throw new Error('Chat step fixture: an explicit native answer is required before the final call');
      }
      const number = results.length + 1;
      if (number > 4) throw new Error('Chat step fixture: unexpected extra provider call');
      const configuredDelay = Number(process.env.STUDIO_SMOKE_STEP_DELAY_MS ?? 160);
      const stepDelay = Number.isSafeInteger(configuredDelay) && configuredDelay >= 0 && configuredDelay <= 60000 ? configuredDelay : 160;
      const reasoning = `步骤 ${number} 的公开测试说明：这是独立模型调用的演示内容，用于验证思考区块逐步显示，不是真实模型推理。`;
      const text = [
        '步骤 1：先联网检索受控来源，再继续核对。',
        '步骤 2：检索已结束，现在检查本对话的临时文件。',
        '步骤 3：请先明确选择是否继续；本轮等待你的回答。',
        '步骤 4：已收到明确回答。多步界面测试完成；这些内容不代表真实工程结果。',
      ][number - 1]!;
      for (const [index, type, content] of [[0, 'reasoning', reasoning], [1, 'text', text]] as const) {
        yield { type: 'block-start', index, blockType: type };
        for (let offset = 0; offset < content.length; offset += 22) {
          await setTimeout(stepDelay, undefined, { signal: options.signal });
          yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index, text: content.slice(offset, offset + 22) };
          // Keep even a one-chunk block observably live before its durable
          // settlement. SSE may otherwise batch its delta with block-end.
          if (offset + 22 >= content.length) await setTimeout(stepDelay, undefined, { signal: options.signal });
        }
        yield { type: 'block-end', index, block: { type, text: content } };
      }
      const calls = [
        { name: 'web_search', args: { queries: ['gear standard'] } },
        { name: 'studio_list_temp_files', args: {} },
        { name: 'ask_user_question', args: { questions: [{ id: 'timeline_continue', header: '继续演示', question: '是否继续到最后一次模型调用？这只验证多步对话界面，不影响任务图谱。', options: [{ label: '继续演示', description: '记录明确回答后继续最后一步。' }, { label: '暂不继续', description: '不确认继续，演示不会生成最终完成输出。' }] }] } },
      ];
      const next = calls[number - 1];
      if (next) {
        const call = { type: 'tool-call' as const, id: brandString<ToolCallId>(randomUUID()), name: next.name, arguments: JSON.stringify(next.args) };
        yield { type: 'block-start', index: 2, blockType: 'tool-call' };
        yield { type: 'block-end', index: 2, block: call };
      }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, totalTokens: 130 } };
      yield { type: 'finish', reason: { kind: next ? 'tool-calls' : 'stop' } };
      return;
    }
    // `[tool-probe]` answers with the tools (name and description) and the system prompt of this very model request, so a
    // deployment test can check what an Agent is offered, e.g. no software or VM tools in the no-software mode.
    if (/^\[tool-probe\](?:\s|$)/u.test(graphPrompt)) {
      const system = options.messages.filter(message => message.role === 'system').flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n');
      const text = `[tool-probe] ${JSON.stringify({ tools: (options.tools ?? []).map(tool => ({ name: tool.name, description: tool.description ?? '' })), system })}`;
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text }; yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    // One controlled Linux sandbox command: `[sandbox-run] {"command":...}` calls studio_sandbox_run once and echoes its result,
    // or says the tool is not offered, so a deployment test can check the sandbox without a real model.
    const sandboxRun = /^\[sandbox-run\]\s*(\{.*\})$/su.exec(graphPrompt);
    if (sandboxRun) {
      const results = options.messages.slice(latestUserIndex + 1).filter(message => message.role === 'tool');
      const offered = options.tools?.some(tool => tool.name === 'studio_sandbox_run') ?? false;
      if (offered && results.length === 0) {
        const call = { type: 'tool-call' as const, id: brandString<ToolCallId>(randomUUID()), name: 'studio_sandbox_run', arguments: JSON.stringify(JSON.parse(sandboxRun[1]!)) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'block-end', index: 0, block: call }; yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      const result = results[0];
      const text = !offered ? '[sandbox-run] studio_sandbox_run is not offered' : `[sandbox-run] ${result!.isError ? 'error' : 'ok'}\n${result!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')}`;
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text }; yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    // Exact disjoint provider counters exercise the real durable metering path.
    // Derive the step from this turn's tool results, so restarts do not reset it.
    const statsScenario = /^\[chat-stats(-no-cache|-zero-cache)?\](?:\s|$)/u.exec(graphPrompt);
    if (statsScenario) {
      const configuredDelay = Number(process.env.STUDIO_SMOKE_STATS_DELAY_MS ?? 450);
      const statsDelay = Number.isSafeInteger(configuredDelay) && configuredDelay >= 0 && configuredDelay <= 60000 ? configuredDelay : 450;
      await setTimeout(statsDelay, undefined, { signal: options.signal });
      const noCache = statsScenario[1] === '-no-cache', zeroCache = statsScenario[1] === '-zero-cache';
      const replayState = { response: { diagnostic: 'chat-stats-private-provider-envelope', credential: 'fixture-only-private-credential' } };
      const results = options.messages.slice(latestUserIndex + 1).filter(message => message.role === 'tool');
      if (!noCache && !zeroCache && results.length === 0) {
        if (!options.tools?.some(tool => tool.name === 'studio_list_temp_files')) throw new Error('Chat stats smoke: expected the native bound temporary file listing tool');
        const call = { type: 'tool-call' as const, id: brandString<ToolCallId>(randomUUID()), name: 'studio_list_temp_files', arguments: '{}' };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: call };
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 20, totalTokens: 170 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' }, replayState };
      } else {
        if (results.some(message => message.isError)) throw new Error('Chat stats smoke: controlled native tool failed');
        const text = '确定性计量测试完成；Token 和缓存计数为测试样本，不代表真实模型消耗。';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'usage', usage: noCache
          ? { inputTokens: 120, outputTokens: 12, totalTokens: 132 }
          : zeroCache ? { inputTokens: 120, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 132 }
          : { inputTokens: 50, outputTokens: 30, cacheReadTokens: 60, cacheWriteTokens: 10, totalTokens: 150 } };
        yield { type: 'finish', reason: { kind: 'stop' }, replayState };
      }
      return;
    }
    const projectFilesScenario = /^\[project-files-[a-z-]+\]\s*(\{.*\})$/su.exec(graphPrompt);
    if (projectFilesScenario) {
      const fixture = JSON.parse(projectFilesScenario[1]) as { scope: 'project' | 'task'; calls: Array<{ name: string; args: Record<string, unknown> }> };
      const schema = options.tools?.find(tool => tool.name === 'studio_list_project_files');
      if (!schema || schema.parameters.type !== 'object') throw new Error('Project file list smoke: native tool schema missing');
      const properties = schema.parameters.properties as Record<string, { type?: unknown }> | undefined;
      if (JSON.stringify(Object.keys(properties ?? {}).sort()) !== JSON.stringify(['limit', 'offset', 'path', 'taskId']) || properties?.taskId?.type !== 'string' || properties?.path?.type !== 'string' || properties?.offset?.type !== 'integer' || properties?.limit?.type !== 'integer') throw new Error('Project file list smoke: native parameters are not the bounded read-only directory contract');
      if (schema.parameters.additionalProperties !== false) throw new Error('Project file list smoke: native arguments must reject extra fields');
      if (fixture.scope === 'task') {
        const projectRead = options.tools?.find(tool => tool.name === 'studio_read_project_file');
        const ownDelete = options.tools?.find(tool => tool.name === 'studio_delete_file');
        if (!projectRead || projectRead.parameters.type !== 'object' || projectRead.parameters.additionalProperties !== false) throw new Error('Project file list smoke: same-project content read schema missing');
        if (!ownDelete || ownDelete.parameters.type !== 'object' || ownDelete.parameters.additionalProperties !== false) throw new Error('Project file list smoke: own-workspace delete schema missing');
        const readFields = (projectRead.parameters.properties ?? {}) as Record<string, { type?: unknown }>;
        const deleteFields = (ownDelete.parameters.properties ?? {}) as Record<string, { type?: unknown }>;
        if (JSON.stringify(Object.keys(readFields).sort()) !== JSON.stringify(['path', 'taskId']) || readFields.taskId?.type !== 'string' || readFields.path?.type !== 'string') throw new Error('Project file list smoke: project read must select exactly one same-project task and relative path');
        if (JSON.stringify(Object.keys(deleteFields).sort()) !== JSON.stringify(['expectedVersion', 'path']) || deleteFields.path?.type !== 'string' || deleteFields.expectedVersion?.type !== 'string') throw new Error('Project file list smoke: delete must remain current-task and optionally version-checked');
      }
      for (const forbidden of fixture.scope === 'project' ? ['studio_task_context', 'studio_read_file', 'studio_read_project_file', 'studio_write_file', 'studio_delete_file', 'studio_software_launch', 'studio_software_status', 'studio_software_control', 'studio_software_invoke', 'studio_software_operation', 'studio_software_cancel', 'studio_software_save_artifact'] : ['studio_project_context']) if (options.tools?.some(tool => tool.name === forbidden)) throw new Error('Project file list smoke: task/project content boundaries changed');
      if (fixture.scope === 'project' && fixture.calls.some(call => call.name.startsWith('studio_software_')) && !options.tools?.some(tool => tool.name === 'studio_software_catalog')) throw new Error('Project software fixture requires the read-only installed-image catalog');
      const results = options.messages.slice(latestUserIndex + 1).filter(message => message.role === 'tool');
      const next = fixture.calls[results.length];
      if (next) {
        const call = { type: 'tool-call' as const, id: brandString<ToolCallId>(randomUUID()), name: next.name, arguments: JSON.stringify(next.args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: call };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const text = fixture.scope === 'task'
          ? 'Project file listing native schemas and explicit same-project content reads verified; live workspace references are non-formal, and mutation remains confined to the current task.'
          : 'Project file listing native schemas and project-planning permissions verified; no task content or mutation authority granted.';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
      return;
    }
    const checklistScenario = /^\[checklist-[a-z-]+\]\s*(\{.*\})$/su.exec(graphPrompt);
    if (checklistScenario) {
      const fixture = JSON.parse(checklistScenario[1]) as {
        scope: 'project' | 'task'; taskId: string; revision?: number; items?: Array<Record<string, unknown>>;
        expectTask?: { id: string; title: string; description: string; checklistTexts: string[] };
        expectAfter?: { id: string; title: string; description: string; checklistTexts: string[] };
      };
      const systemText = options.messages.filter(message => message.role === 'system')
        .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n');
      if (!systemText.includes('当前单用户任务 metadata 只包含任务名称、任务描述和文字 checklist')) throw new Error('Checklist smoke: the TODO plugin instructions are missing from the actual system prompt');
      for (const name of ['studio_read_checklist', 'studio_update_checklist']) {
        const schema = options.tools?.find(tool => tool.name === name);
        if (!schema || schema.parameters.type !== 'object') throw new Error(`Checklist smoke: native schema missing for ${name}`);
        const properties = schema.parameters.properties as Record<string, { type?: unknown }> | undefined;
        if (properties?.taskId?.type !== 'string') throw new Error(`Checklist smoke: ${name} must expose a native taskId string`);
        if (name === 'studio_update_checklist' && (properties?.revision?.type !== 'number' || properties?.items?.type !== 'string')) throw new Error('Checklist smoke: update must expose native revision and JSON items parameters');
      }
      const forbidden = fixture.scope === 'project' ? ['studio_task_context', 'studio_read_file', 'studio_read_project_file', 'studio_write_file', 'studio_delete_file'] : ['studio_project_context'];
      for (const name of forbidden) if (options.tools?.some(tool => tool.name === name)) throw new Error(`Checklist smoke: forbidden ${name} was advertised in ${fixture.scope} scope`);
      // The current persisted turn, rather than a process-local counter, controls
      // these probes so native tool histories can resume after a server restart.
      const results = options.messages.slice(latestUserIndex + 1).filter(message => message.role === 'tool');
      const expected = results.length >= 2 && !results[1]?.isError && fixture.expectAfter ? fixture.expectAfter : fixture.expectTask;
      if (expected) {
        const marker = 'Current live task metadata, permissions and hierarchy:\n';
        const position = systemText.lastIndexOf(marker);
        if (position < 0) throw new Error('Checklist smoke: missing live task metadata system section');
        const current = JSON.parse(systemText.slice(position + marker.length).split('\n')[0]!) as { id: string; title: string; description: string; checklist: Array<{ text: string }> };
        if (current.id !== expected.id || current.title !== expected.title || current.description !== expected.description || JSON.stringify(current.checklist.map(item => item.text)) !== JSON.stringify(expected.checklistTexts)) throw new Error('Checklist smoke: actual model request did not contain the latest shared title, description and checklist');
      }
      let next: { name: string; args: Record<string, unknown> } | undefined;
      if (!results.length) next = { name: 'studio_read_checklist', args: { taskId: fixture.taskId } };
      else if (fixture.items && results.length === 1) {
        const revision = fixture.revision ?? (results[0]?.isError ? undefined : (JSON.parse(results[0]!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')) as { revision: number }).revision);
        if (revision === undefined) throw new Error('Checklist smoke: rejected reads require an explicit controlled revision before probing a rejected update');
        next = { name: 'studio_update_checklist', args: { taskId: fixture.taskId, revision, items: JSON.stringify(fixture.items) } };
      } else if (fixture.items && results.length === 2) next = { name: 'studio_read_checklist', args: { taskId: fixture.taskId } };
      if (next) {
        const call = { type: 'tool-call' as const, id: brandString<ToolCallId>(randomUUID()), name: next.name, arguments: JSON.stringify(next.args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: call };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const text = 'Checklist native schemas and live shared system metadata verified; controlled TODO probe complete. No external model, network or industrial software called.';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
      return;
    }
    const graphScenario = /^\[graph-plan-[a-z-]+\]\s*(\{.*\})$/su.exec(graphPrompt);
    if (graphScenario) {
      const systemText = options.messages.filter(message => message.role === 'system')
        .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n');
      if (!systemText.includes('你可以通过对话维护用户当前项目的任务图谱')) throw new Error('Graph planning smoke: the plugin planning prompt was not assembled into the actual system message');
      const fixture = JSON.parse(graphScenario[1]) as {
        scope: 'project' | 'task'; query?: { offset?: number; limit?: number }; patch?: Record<string, unknown>;
      };
      for (const name of ['studio_graph_context', 'studio_apply_graph_patch']) {
        const schema = options.tools?.find(tool => tool.name === name);
        if (!schema || schema.parameters.type !== 'object') throw new Error(`Graph planning smoke: native schema missing for ${name}`);
        const properties = schema.parameters.properties as Record<string, { type?: unknown }> | undefined;
        if (name === 'studio_apply_graph_patch' && properties?.patch?.type !== 'string') throw new Error('Graph planning smoke: graph patch must be a native string parameter');
      }
      const forbidden = fixture.scope === 'project' ? ['studio_task_context', 'studio_read_file', 'studio_read_project_file', 'studio_write_file', 'studio_delete_file'] : ['studio_project_context'];
      for (const name of forbidden) if (options.tools?.some(tool => tool.name === name)) throw new Error(`Graph planning smoke: forbidden ${name} was advertised in ${fixture.scope} scope`);
      // Derive progress from the current turn's persisted tool results, so resumed
      // conversations never depend on the adapter's in-memory stage counters.
      const results = options.messages.slice(latestUserIndex + 1).filter(message => message.role === 'tool');
      let next: { name: string; args: Record<string, unknown> } | undefined;
      if (results.length === 0) next = { name: 'studio_graph_context', args: fixture.query ?? {} };
      else if (fixture.patch && results.length === 1) {
        const first = results[0];
        if (first.isError) throw new Error('Graph planning smoke: cannot apply a patch after failed graph context');
        const context = JSON.parse(first.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')) as { project: { revision: number } };
        const patch = { ...fixture.patch, revision: fixture.patch.revision ?? context.project.revision };
        next = { name: 'studio_apply_graph_patch', args: { patch: JSON.stringify(patch) } };
      } else if (fixture.patch && results.length === 2) next = { name: 'studio_graph_context', args: fixture.query ?? {} };
      if (next) {
        const call = { type: 'tool-call' as const, id: brandString<ToolCallId>(randomUUID()), name: next.name, arguments: JSON.stringify(next.args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: call };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const text = '图谱规划受控测试结束；请核对实际工具结果。Graph planning native schemas verified; no external model or engineering software called.';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
      return;
    }
    if (currentPrompt.includes('[project-chat-only]')) {
      const text = '项目规划对话已保存；本轮没有创建任务。Project conversation without a hidden task.';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    if (currentPrompt.includes('[task-input-context]')) {
      const ids = [...currentPrompt.matchAll(/s-[0-9a-f-]{36}/g)].map(match => match[0]);
      if (ids.length !== 2) throw new Error('Task input smoke requires one actual nested input snapshot and one unrelated snapshot');
      const position = this.taskContextSteps.get(key) ?? 0;
      const calls = [
        { name: 'studio_task_context', args: {} },
        { name: 'studio_read_file', args: { snapshotId: ids[0], path: 'report.md' } },
        { name: 'studio_read_file', args: { snapshotId: ids[1], path: 'report.md' } },
      ];
      this.taskContextSteps.set(key, (position + 1) % (calls.length + 1));
      const next = calls[position];
      if (next) {
        const call = { type: 'tool-call' as const, id: brandString<ToolCallId>(randomUUID()), name: next.name, arguments: JSON.stringify(next.args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: call };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const text = '任务上下文与正式目录输入测试结束；请检查快照引用和受控文件读取结果。Immutable nested input context checked.';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
      return;
    }
    if (currentPrompt.includes('[project-ui]') || currentPrompt.includes('[task-project-tools]')) {
      const taskScopeProbe = currentPrompt.includes('[task-project-tools]');
      const taskTools = ['studio_task_context', 'studio_read_file', 'studio_read_project_file', 'studio_write_file', 'studio_delete_file'];
      const projectTools = ['studio_project_context', 'studio_create_task'];
      const required = [...(taskScopeProbe ? [...taskTools, 'studio_create_task'] : projectTools), 'studio_write_temp_file', 'studio_read_temp_file'];
      for (const name of required) {
        const schema = options.tools?.find(tool => tool.name === name);
        if (!schema || schema.parameters.type !== 'object') throw new Error(`Project smoke: native schema missing for ${name}`);
      }
      for (const name of taskScopeProbe ? ['studio_project_context'] : taskTools) {
        if (options.tools?.some(tool => tool.name === name)) throw new Error(`Project smoke: forbidden ${name} was advertised in this scope`);
      }
      const projectStage = this.projectSteps.get(key) ?? 0;
      const definition = { title: '校核项目齿轮齿宽（测试草稿）', kind: 'task', goal: '建立具体齿轮验收任务；仅为受控测试', constraints: '测试参数不能当作真实工程参数',
        criteria: [{ id: 'width', label: '齿宽', kind: 'numeric', rule: 'eq', target: 40, tolerance: 0.1, unit: 'mm', method: '读取尺寸报告并核对' }], outputs: ['report.md'], unresolved: [] };
      const calls = taskScopeProbe ? [
        { name: 'studio_project_context', args: {} },
        { name: 'studio_create_task', args: { definition: JSON.stringify(definition) } },
      ] : [
        { name: 'studio_project_context', args: {} },
        { name: 'studio_create_task', args: { definition: JSON.stringify(definition) } },
        { name: 'studio_write_temp_file', args: { path: 'scratch.txt', content: 'project-chat-only' } },
        { name: 'studio_read_temp_file', args: { path: 'scratch.txt', offset: 0, limit: 30 } },
        { name: 'studio_task_context', args: {} },
        { name: 'studio_read_file', args: { path: 'scratch.txt' } },
        { name: 'studio_read_project_file', args: { taskId: 'm1-gear', path: 'scratch.txt' } },
        { name: 'studio_write_file', args: { path: 'forbidden-from-project.txt', content: 'must be rejected' } },
        { name: 'studio_delete_file', args: { path: 'forbidden-from-project.txt' } },
      ];
      this.projectSteps.set(key, (projectStage + 1) % (calls.length + 1));
      const next = calls[projectStage];
      if (next) {
        const call = { type: 'tool-call' as const, id: brandString<ToolCallId>(randomUUID()), name: next.name, arguments: JSON.stringify(next.args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: call };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const text = taskScopeProbe ? '项目上下文不属于任务对话；进行中的父任务不允许新增子任务。Project context is forbidden; a working parent cannot create children.'
          : '项目会话原生工具测试完成；已建立待进行任务，工作区操作均被拒绝。Project native tool schemas verified.';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
      return;
    }
    if (currentPrompt.includes('[task-draft-chat]') || currentPrompt.includes('[task-child-create]')) {
      const childScenario = currentPrompt.includes('[task-child-create]');
      const allowed = ['ask_user_question', 'studio_apply_graph_patch', 'studio_browser_read', 'studio_create_task', 'studio_delete_file', 'studio_download_temp_file', 'studio_extract_temp_zip', 'studio_graph_context', 'studio_list_project_files', 'studio_list_temp_files', 'studio_read_checklist', 'studio_read_file', 'studio_read_project_file', 'studio_read_temp_file', 'studio_retrieve_context', 'studio_search_temp_file', 'studio_software_cancel', 'studio_software_catalog', 'studio_software_control', 'studio_software_invoke', 'studio_software_launch', 'studio_software_operation', 'studio_software_save_artifact', 'studio_software_status', 'studio_task_context', 'studio_update_checklist', 'studio_write_file', 'studio_write_temp_file', 'web_fetch', 'web_search'];
      const actual = options.tools?.map(tool => tool.name).sort();
      if (JSON.stringify(actual) !== JSON.stringify(allowed)) throw new Error('Task draft smoke: expected restricted native tools with bound graph planning, context retrieval, image selection, text checklist and no project context');
      const stages = childScenario ? this.taskChildSteps : this.taskDraftSteps;
      const position = stages.get(key) ?? 0;
      const definition = { title: '校核子任务齿宽（受控测试）', kind: 'task', goal: '验证绑定父任务的子任务创建', constraints: '仅为运行时权限测试',
        criteria: [{ id: 'width', label: '齿宽', kind: 'numeric', rule: 'eq', target: 40, unit: 'mm', method: '核对受控测试报告' }], outputs: ['report.md'], unresolved: [] };
      const calls = childScenario ? [
        { name: 'studio_create_task', args: { definition: JSON.stringify(definition) } },
        { name: 'studio_create_task', args: { definition: JSON.stringify({ ...definition, parentId: 'm1-gear' }) } },
        { name: 'studio_task_context', args: {} },
        { name: 'studio_write_file', args: { path: 'folder-summary.md', content: 'active task folders own their workspace' } },
        { name: 'studio_read_file', args: { path: 'folder-summary.md' } },
        { name: 'studio_delete_file', args: { path: 'folder-summary.md' } },
      ] : [
        { name: 'studio_task_context', args: {} },
        { name: 'studio_write_temp_file', args: { path: 'planning.txt', content: 'allocated-task-private-draft' } },
        { name: 'studio_read_temp_file', args: { path: 'planning.txt', offset: 0, limit: 100 } },
        { name: 'studio_write_file', args: { path: 'ordinary-draft.md', content: 'active task owns this file' } },
        { name: 'studio_read_file', args: { path: 'ordinary-draft.md' } },
        { name: 'studio_delete_file', args: { path: 'ordinary-draft.md' } },
      ];
      stages.set(key, (position + 1) % (calls.length + 1));
      const next = calls[position];
      if (next) {
        const call = { type: 'tool-call' as const, id: brandString<ToolCallId>(randomUUID()), name: next.name, arguments: JSON.stringify(next.args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: call };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const text = childScenario ? '已验证绑定父任务创建、错误父节点拒绝与活动任务目录自有文件增删改权限。Controlled child planning complete.'
          : '已分配草稿可讨论、读写私有临时文件，并可增删改自己的普通工作文件；任务状态仍未启动。Controlled allocated draft discussion complete.';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
      return;
    }
    if (currentPrompt.includes('[web-ui]')) {
      const required = ['web_search', 'web_fetch', 'studio_download_temp_file', 'studio_extract_temp_zip', 'studio_write_temp_file', 'studio_read_temp_file', 'studio_search_temp_file', 'studio_list_temp_files'];
      for (const name of required) {
        const schema = options.tools?.find(tool => tool.name === name);
        if (!schema || schema.parameters.type !== 'object') throw new Error(`Web smoke: native schema missing for ${name}`);
      }
      const webStage = this.webSteps.get(key) ?? 0;
      this.webSteps.set(key, (webStage + 1) % 5);
      const calls = [
        { name: 'web_search', args: { queries: ['gear standard', 'bearing standard'] } },
        { name: 'web_fetch', args: { url: 'https://fixture.invalid/gear' } },
        { name: 'studio_write_temp_file', args: { path: 'scratch.txt', content: 'only-this-chat' } },
        { name: 'studio_read_temp_file', args: { path: 'scratch.txt', offset: 0, limit: 20 } },
      ];
      const next = calls[webStage];
      if (next) {
        const call = { type: 'tool-call' as const, id: brandString<ToolCallId>(randomUUID()), name: next.name, arguments: JSON.stringify(next.args) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: call };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const text = '受控联网测试完成（非真实网络或工程结果）。Native tool schemas verified.\n\n已读取[齿轮测试来源](https://fixture.invalid/gear)，并将结果保存在本对话临时目录。';
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
      return;
    }
    if (currentPrompt.includes('[chat-ui]')) {
      const reasoning = '这是界面测试适配器返回的公开演示说明，不是真实模型推理。\n\n先检查任务目标，再核对工作区文件和验收指标；结果只用于验证流式显示。';
      const text = `已收到你的消息。下面是**聊天界面验收演示**，这些内容不代表真实工程结果。\n\n${Array.from({ length: 24 }, (_, index) => `### 演示检查项 ${index + 1}\n\n记录任务目标、输入版本和文件证据。对照已配置的指标核对结果，保留未确认事项，完成后再送验。这些文字用于验证长对话在聊天区域内滚动。`).join('\n\n')}`;
      for (const [index, type, content] of [[0, 'reasoning', reasoning], [1, 'text', text]] as const) {
        yield { type: 'block-start', index, blockType: type };
        for (let offset = 0; offset < content.length; offset += 70) {
          await setTimeout(110, undefined, { signal: options.signal });
          yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index, text: content.slice(offset, offset + 70) };
        }
        yield { type: 'block-end', index, block: { type, text: content } };
      }
      yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    if (stage === 0 && scenario.includes('[slow]')) await setTimeout(5000, undefined, { signal: options.signal });
    const path = scenario.includes('[escape]') ? '../m1-bearing/forbidden.txt' : 'm1-proof.txt';
    if (stage < 2) {
      const call = { type: 'tool-call' as const, id: brandString<ToolCallId>(randomUUID()),
        name: stage === 0 ? 'studio_write_file' : 'studio_read_file',
        arguments: JSON.stringify(stage === 0 ? { path, content: 'M1：通过 DSH 工具调用创建的齿轮参数记录（测试数据）。' } : { path }) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'block-end', index: 0, block: call };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      const text = 'M1 测试适配器序列结束，请查看工具结果；这不表示工程任务已验收。';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}

/** A separate, keyless vision fixture verifies actual admitted bytes; production model facts are unchanged. */
class AttachmentSmokeAdapter extends SmokeAdapter {
  constructor(private readonly ctx: Context) { super(); }
  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'vision-smoke', name: 'Attachment fixture with declared image input' }]);
  }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, context: { contextWindow: 64000 }, inputModalities: ['text', 'image'] as const };
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const user = options.messages.findLast(message => message.role === 'user' && message.source?.kind === 'user');
    const text = user?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? '';
    const probe = /^\[attachment-probe\]\s*(\{[^\n]*\})/u.exec(text);
    if (!probe) { yield* super.stream(options); return; }
    const fixture = JSON.parse(probe[1]!) as { expectedImages: number; expectedNames?: string[] };
    const images = user!.content.filter(block => block.type === 'image');
    if (images.length !== fixture.expectedImages) throw new Error('Attachment smoke: actual provider image-block count mismatch');
    const names: string[] = []; let imageBytes = 0;
    for (const image of images) {
      const stored = await this.ctx.attachments.readImage(image.attachment);
      if (stored.data.length !== stored.ref.bytes || stored.ref.width < 1 || stored.ref.height < 1) throw new Error('Attachment smoke: model reference has no verified image bytes');
      imageBytes += stored.data.length; names.push(stored.ref.name ?? '');
    }
    if (fixture.expectedNames && JSON.stringify(names) !== JSON.stringify(fixture.expectedNames)) throw new Error('Attachment smoke: provider image display names mismatch');
    const answer = `Attachment provider request verified: ${images.length} actual image blocks, ${imageBytes} verified binary bytes; names ${JSON.stringify(names)}. This fixture does not perform engineering interpretation.`;
    yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: answer };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }; yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

/** Pure helpers of the autonomy script, exported for unit tests. */
export * as autonomySmoke from './autonomy-probe.ts';

/** Add keyless model tests and temporary purge probes only under the explicit smoke overlay. */
export function apply(ctx: Context): void {
  installM4Probe(ctx);
  installM5Probe(ctx);
  ctx.llm.registerAdapter(['studio-smoke'], new SmokeAdapter());
  ctx.llm.registerAdapter(['studio-vision-smoke'], new AttachmentSmokeAdapter(ctx));
  // These providers never use the network. The smoke overlay selects them explicitly.
  if (process.env.STUDIO_SMOKE_WIRE === '1') ctx.effect(() => { wire = new SmokeWire(); return () => { wire?.close(); wire = undefined; }; }, 'smoke: loopback model wire');
  ctx.web.registerSearchProvider({ id: 'studio-web-smoke', available: () => true, async search(request, signal) {
    signal?.throwIfAborted();
    await wire?.search(request.query, signal);
    const probeDelay = Number(process.env.STUDIO_SMOKE_WEB_DELAY_MS ?? 0);
    if (Number.isSafeInteger(probeDelay) && probeDelay > 0 && probeDelay <= 60000) await setTimeout(probeDelay, undefined, { signal });
    const topic = request.query === 'gear standard' ? 'gear' : request.query === 'bearing standard' ? 'bearing' : undefined;
    if (!topic) throw new Error('Web smoke accepts only its declared fixture queries');
    return { truncated: false, sources: [
      { url: 'https://fixture.invalid/shared', title: 'Shared mechanical standard', snippet: 'Deterministic shared reference', publishedAt: '2026-10-09' },
      { url: `https://fixture.invalid/${topic}`, title: `${topic} standard`, snippet: `Deterministic ${topic} reference`, publishedAt: '2026-10-08' },
    ] };
  } });
  ctx.web.registerFetchProvider({ id: 'studio-web-smoke', available: () => true, async fetch(request, signal) {
    signal?.throwIfAborted();
    if (request.url !== 'https://fixture.invalid/gear') throw new Error('Web smoke accepts only its declared fixture URL');
    const content = `STUDIO-WEB-FIXTURE\n${Array.from({ length: 1200 }, (_, index) => `Fixture paragraph ${index + 1}: gear standard quantitative verification uses deterministic parameters, tolerances and source citations.`).join('\n')}\nEND-STUDIO-WEB-FIXTURE`;
    return { url: request.url, statusCode: 200, body: { kind: 'text', content }, truncated: false };
  } });
  const confirmations = new Map<string, { taskId: string; generation: number; expires: number }>();
  ctx.effect(() => () => confirmations.clear(), 'smoke: confirmations');
  for (const path of ['/api/studio/m1/purge-preview', '/api/studio/m1/purge']) {
    ctx.connection.fetch.register({ path, methods: ['POST'], requestBody: 'buffered', async fetch(request) {
      try {
        const raw: unknown = await request.json();
        if (raw === null || typeof raw !== 'object' || !('taskId' in raw) || typeof raw.taskId !== 'string') throw new Error('Expected taskId');
        const lease = ctx.studio.files.lease(raw.taskId);
        if (path.endsWith('purge-preview')) {
          const confirmation = randomUUID();
          confirmations.set(confirmation, { ...lease, expires: Date.now() + 30000 });
          return Response.json({ taskId: lease.taskId, confirmation, warning: 'Test-only: deletes all fixture files and chats without backup.' });
        }
        if (!('confirmation' in raw) || typeof raw.confirmation !== 'string') throw new Error('Second confirmation required');
        const permit = confirmations.get(raw.confirmation);
        confirmations.delete(raw.confirmation);
        if (!permit || permit.taskId !== lease.taskId || permit.generation !== lease.generation || permit.expires < Date.now()) throw new Error('Confirmation expired or does not match');
        await ctx.studio.purge(lease.taskId);
        return Response.json({ purged: true });
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : 'Smoke failed' }, { status: 400 });
      }
    } });
  }
}
