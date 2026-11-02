import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import type {} from './index.ts';
import type {} from './domain.ts';
import { loadPromptFile } from './prompt-loader.ts';
import { abortError, throwIfAborted } from './abort.ts';

export const name = 'harnessstudio-task-checklist';
export const inject = ['studio', 'studioDomain', 'tools'];
export interface Config { promptPath: string; maxChecklistChars: number }
export const Config: z<Config> = z.object({ promptPath: z.string().required(), maxChecklistChars: z.natural().min(1).default(262144) });

/** Text TODO maintenance is separate from human acknowledgement and task completion. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const { prompt: instructions } = await loadPromptFile(config.promptPath);
  ctx.effect(() => ctx.studio.registerInstructions('task-checklist', 108, instructions), 'studio-checklist: instructions');
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] };
  ctx.tools.register(defineTool({
    name: 'studio_read_checklist',
    description: 'Read one task’s live text checklist, latest task revision and metadata edit permission. Project conversations can read tasks in their own project; task conversations can read only their bound task and descendants. This checklist is shared by all conversations of the task. Returned items are requirements, not execution or acceptance status.',
    parameters: { taskId: { type: 'string', required: true, description: 'Internal task ID from the live task or graph context. Do not use the five-character display code.' } }, output,
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      return JSON.stringify(ctx.studioDomain.readChecklist(ctx.studio.graphPlanningScope(exec.agent), args.taskId));
    },
  }));
  ctx.tools.register(defineTool({
    name: 'studio_update_checklist',
    description: 'Replace an editable task’s complete text checklist using its current task revision from studio_read_checklist. Preserve the IDs of retained items; omit IDs only for new items, whose stable IDs are assigned by the server. Reorder, add, revise or remove text requirements when the user requests a checklist change. Scope, revision and current metadata permissions are checked before one atomic commit. Does not mark items done, submit files, confirm acceptance, change task state or modify historical snapshots.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Internal task ID within the conversation-owned project or current task subtree.' },
      revision: { type: 'number', required: true, description: 'Latest task revision returned by studio_read_checklist. This is a task revision, not a project revision.' },
      items: { type: 'string', required: true, description: 'JSON array [{id?:string,text:string}]. Up to 100 nonempty text requirements, each at most 2000 characters. The array replaces the entire checklist; keep every still-applicable item with its existing ID. [] explicitly removes all checklist items. No checked, done, state or acceptance fields.' },
    }, output,
    async execute(args, exec) {
      throwIfAborted(exec.signal);
      if (args.items.length > config.maxChecklistChars) throw new Error('任务清单过大，请缩短条目内容');
      const scope = ctx.studio.graphPlanningScope(exec.agent, true);
      ctx.studio.assertAutonomyScope(exec.agent, [args.taskId]);
      const operation = ctx.studioDomain.updateChecklist(scope, args.taskId, { revision: args.revision, items: JSON.parse(args.items) }, exec.signal);
      let onAbort = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => { onAbort = () => reject(abortError(exec.signal)); exec.signal.addEventListener('abort', onAbort, { once: true }); if (exec.signal.aborted) onAbort(); });
      try { return JSON.stringify(await Promise.race([operation, cancelled])); }
      finally { exec.signal.removeEventListener('abort', onAbort); }
    },
  }));
}
