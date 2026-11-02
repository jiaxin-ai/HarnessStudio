import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import type {} from './index.ts';
import type {} from './domain.ts';
import { loadPromptFile } from './prompt-loader.ts';
import { abortError, throwIfAborted } from './abort.ts';

export const name = 'harnessstudio-graph-planning';
export const inject = ['studio', 'studioDomain', 'tools'];
export interface Config { promptPath: string; maxPatchChars: number }
export const Config: z<Config> = z.object({ promptPath: z.string().required(), maxPatchChars: z.natural().min(1).default(65536) });

/** IDs a graph patch changes or attaches to, for the autonomy branch scope (null is the project root; "$key" references
 * and an omitted parent, which is the conversation's own task, need no check). structural IDs are moved, re-linked or removed. */
export function patchTargets(patch: unknown): { ids: (string | null)[]; structural: string[] } {
  const ids: (string | null)[] = [], structural: string[] = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ids, structural };
  const data = patch as Record<string, unknown>;
  const rows = (value: unknown) => Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [];
  const ref = (value: unknown): value is string => typeof value === 'string' && !value.startsWith('$');
  const parent = (value: unknown) => { if (value === null) ids.push(null); else if (ref(value)) ids.push(value); };
  const list = (value: unknown) => { if (Array.isArray(value)) for (const id of value) if (ref(id)) ids.push(id); };
  for (const row of rows(data.creates)) { parent(row.parentId); list(row.dependencies); }
  for (const row of rows(data.updates)) if (ref(row.id)) ids.push(row.id);
  for (const row of rows(data.moves)) { if (ref(row.id)) { ids.push(row.id); structural.push(row.id); } parent(row.parentId); }
  for (const row of rows(data.dependencies)) { if (ref(row.id)) { ids.push(row.id); structural.push(row.id); } list(row.dependencies); }
  for (const row of rows(data.removes)) if (ref(row.id)) { ids.push(row.id); structural.push(row.id); }
  return { ids, structural };
}

/** Graph planning is a product plugin: DSH still owns model routing, loop, tools and compression. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const { prompt: instructions } = await loadPromptFile(config.promptPath);
  ctx.effect(() => ctx.studio.registerInstructions('graph-planning', 107, instructions), 'studio-planning: instructions');
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
  ctx.tools.register(defineTool({
    name: 'studio_graph_context',
    description: 'Read the complete editable planning graph for the conversation’s bound project, including root-level tasks, ancestors, siblings, descendants and their dependencies. Before an initial multi-node plan, identify the distinct peer workstreams that belong at project root; an existing or first-created root is not an automatic wrapper for later parallel work. A task conversation’s taskId is its current-task anchor and the default parent for omitted parentId only, not a graph-visibility or graph-edit boundary. Cross-project access is always refused. Nodes are paginated in rank order; read every relevant page and the reported capabilities before modifying an existing graph.',
    parameters: { offset: { type: 'number', description: 'Zero-based node offset, default 0.' }, limit: { type: 'number', description: 'Nodes per page, default 50, maximum 100.' } }, output,
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      return JSON.stringify(ctx.studioDomain.planningContext(ctx.studio.graphPlanningScope(exec.agent), args));
    },
  }));
  ctx.tools.register(defineTool({
    name: 'studio_apply_graph_patch',
    description: 'Apply one atomic planning change anywhere in the conversation’s bound project graph. Use the latest project revision from studio_graph_context. For an initial plan with multiple independent or sequential workstreams, create the peer root nodes together in this patch (explicit parentId null is clearest) and express their ordering with root-level dependencies; do not create a redundant whole-project wrapper or attach parallel work beneath the first node merely because it was created first. Nest only true decomposition whose child results roll up to that parent. Create concrete tasks, refine existing definitions, move eligible plan nodes, replace complete dependency lists, or recoverably remove an unused pure-draft leaf from the active graph. A task conversation may revise root-level, ancestor, sibling and descendant planning nodes; its taskId remains the current-task anchor and default parent only. Cross-project references are refused. Local references "$key" allow a connected nested plan in one call. Direct dependencies must connect same-parent siblings and remain acyclic; an ancestor dependency is inherited by its descendants. Unexecuted plans may be adjusted dynamically. Changes that touch execution, bound inputs or snapshot history never rewrite history and must follow the server’s impact-confirmation and invalidation/recheck safeguards. A removes batch must contain no creates, updates, moves or dependency replacements and can remove only a same-project, non-anchor leaf with no child, incoming dependency/input reference or execution history. Removal archives it outside the active graph while retaining its workspace, conversations and audit data; a draft’s own outgoing prerequisites are harmless and are detached. Any historical or referenced node must instead use the human deletion impact preview and second confirmation. All operations either commit or fail together; existing task IDs and ranks remain stable. This tool does not start/complete tasks or modify engineering files.',
    parameters: { patch: { type: 'string', required: true, description: 'JSON {revision:number,creates?:[{key:string,definition:{title:string,goal?:string,checklist?:[{id?:string,text:string}]},parentId?:string|null,dependencies?:string[]}],updates?:[{id:string,changes:{title?:string,goal?:string,checklist?:[{id?:string,text:string}]}}],moves?:[{id:string,parentId:string|null}],dependencies?:[{id:string,dependencies:string[]}],removes?:[{id:string}]}. Current single-user metadata is title, detailed description in goal, and a plain-text checklist. New checklist item IDs are server-assigned; retain existing IDs when changing text or order. IDs for creates, updates, moves and dependencies are existing internal task IDs from this bound project or "$key" references to creates in this batch. key matches [A-Za-z][A-Za-z0-9_-]{0,31}. In a project conversation, an omitted parent creates at project root; in a task conversation, it defaults to the anchored current task. Explicit null means project root in either conversation. Direct dependencies are complete replacement lists of same-parent siblings; use an ancestor-level dependency when a whole branch needs the same predecessor. removes accepts only existing internal IDs, never "$key", and must be the only operation kind in its batch. It is a recoverable active-graph archival operation only for a non-anchor pure-draft leaf with no child, incoming dependency/input reference or execution/snapshot history; retained workspace/conversation data are not destroyed. Otherwise use the UI deletion preview and human second confirmation. At most 50 operations. Only supplied definition fields change. Legacy criteria/constraints/outputs/unresolved fields remain compatible with the reviewed workflow; do not create complex numeric criterion forms in current single-user planning. No checked/done, state, code, rank or projectId fields.' } }, output,
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      if (args.patch.length > config.maxPatchChars) throw new Error('图谱变更过大，请拆成较小的规划步骤');
      const scope = ctx.studio.graphPlanningScope(exec.agent, true), patch = JSON.parse(args.patch);
      const targets = patchTargets(patch); ctx.studio.assertAutonomyScope(exec.agent, targets.ids, targets.structural);
      const operation = ctx.studioDomain.applyGraphPatch(scope, patch, exec.signal);
      // A queued mutation checks cancellation before committing. Return promptly when the Agent stops.
      let onAbort = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => { onAbort = () => reject(abortError(exec.signal)); exec.signal.addEventListener('abort', onAbort, { once: true }); if (exec.signal.aborted) onAbort(); });
      try { return JSON.stringify(await Promise.race([operation, cancelled])); }
      finally { exec.signal.removeEventListener('abort', onAbort); }
    },
  }));
}
