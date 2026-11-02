/** The no-software backend (STUDIO_SEAT_BACKEND=none), for deployments without vm_manager. Studio then has no software at all:
 * neither the Mock platform nor VMs stand in. No software or VM tool is registered, the software routes answer that no software
 * is connected, and one short prompt section tells the Agent to work with files, the Linux sandbox and the web. Task and
 * project files live in Studio's data folder (domain.ts, LOCAL_FILES_FOLDER). */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from './index.ts';
import { loadPromptFile } from './prompt-loader.ts';
import { registerProjectExport } from './project-export.ts';

/** Every /api/studio/software/* route of the Mock and VM backends; each answers SOFTWARE_NOT_CONFIGURED here. */
export const SOFTWARE_ROUTES = ['catalog', 'seats', 'seat', 'control', 'invoke', 'ack-unknown', 'operation', 'cancel', 'artifact', 'release', 'records', 'recorder', 'events',
  'recordings', 'recording', 'recording-file', 'recording-zip', 'progress', 'start', 'controller', 'license', 'assign', 'resources', 'jobs', 'job-cancel'] as const;
export const SOFTWARE_NOT_CONFIGURED = 'SOFTWARE_NOT_CONFIGURED';
export const NO_SOFTWARE_MESSAGE = '当前部署没有接入软件（无软件模式），软件和虚拟机功能不可用';
/** A clear, non-5xx answer: the feature does not exist in this deployment. */
export function noSoftwareResponse(): Response {
  return Response.json({ error: NO_SOFTWARE_MESSAGE, code: SOFTWARE_NOT_CONFIGURED, softwareBackend: 'none' }, { status: 404 });
}

export async function applyNoSoftware(ctx: Context, config: { noSoftwarePromptPath: string }): Promise<void> {
  // The export has no vm/ part and no VM warnings without a VM source.
  registerProjectExport(ctx);
  const { prompt } = await loadPromptFile(config.noSoftwarePromptPath);
  // The slot the Mock and VM prompts use, so exactly one software section exists in every mode.
  ctx.effect(() => ctx.studio.registerInstructions('software-seat-text', 113, prompt), 'studio-seat: no-software prompt');
  for (const path of SOFTWARE_ROUTES) ctx.connection.fetch.register({ path: '/api/studio/software/' + path, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: async () => noSoftwareResponse() });
}
