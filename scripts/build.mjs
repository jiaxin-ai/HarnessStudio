import { build } from 'esbuild';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { root, prepare } from './prepare.mjs';

await prepare();
for (const name of ['studio', 'ui', 'smoke']) {
  await build({
    entryPoints: [join(root, 'plugins', name, 'src/index.ts')],
    outfile: join(root, 'plugins', name, 'lib/index.js'),
    platform: 'node', format: 'esm', target: 'node22', bundle: true, packages: 'external', sourcemap: true,
  });
}
await build({ entryPoints: ['plugins/studio/src/workspace.ts'], outfile: 'plugins/studio/lib/workspace.js',
  platform: 'node', format: 'esm', target: 'node22', bundle: true });
await build({ entryPoints: ['plugins/studio/src/models.ts'], outfile: 'plugins/studio/lib/models.js',
  platform: 'node', format: 'esm', target: 'node22', bundle: true, packages: 'external' });
for (const name of ['browser-access', 'browser-reader', 'browser-egress', 'engineering-context', 'seat', 'no-software', 'seat-origin', 'seat-types', 'vm-seat', 'vm-agent', 'vm-recordings', 'vm-jobs', 'domain', 'domain-types', 'file-descriptions', 'chat-types', 'chat-activity', 'chat-audit', 'chat-audit-types', 'chat-audit-report', 'chat-debug', 'chat-export', 'chat-transfer', 'chat-metrics', 'chat-stream', 'chat-scratch', 'chat-attachment-types', 'chat-attachments', 'questions', 'questions-types', 'questions-validation', 'web', 'web-fetch', 'web-pdf-text', 'web-pdf-worker', 'network', 'planning', 'todo', 'prompt-loader', 'conversation-delete', 'managed-delete', 'activity', 'timeline', 'zip-stream', 'project-export', 'skills', 'mcp', 'plugins', 'sandbox', 'autonomy', 'autonomy-types', 'autonomy-store', 'autonomy-compaction', 'abort']) await build({ entryPoints: [`plugins/studio/src/${name}.ts`], outfile: `plugins/studio/lib/${name}.js`,
  platform: 'node', format: 'esm', target: 'node22', bundle: true, packages: 'external', external: ['@deepseek-ai/*'] });
for (const name of ['server', 'cli', 'profiles/solidworks', 'profiles/ansys', 'profiles/autocad']) await build({ entryPoints: [`apps/mock-seat/src/${name}.ts`], outfile: `apps/mock-seat/lib/${name}.js`, platform: 'node', format: 'esm', target: 'node22', bundle: true, packages: 'external' });
for (const name of ['server', 'cli']) await build({ entryPoints: [`apps/sandbox-manager/src/${name}.ts`], outfile: `apps/sandbox-manager/lib/${name}.js`, platform: 'node', format: 'esm', target: 'node22', bundle: true, packages: 'external' });
await build({ entryPoints: ['plugins/ui/src/chat-state.ts'], outfile: 'plugins/ui/lib/chat-state.js', platform: 'node', format: 'esm', target: 'node22', bundle: true });
const result = await build({
  entryPoints: ['plugins/ui/src/client.tsx'], bundle: true, write: false,
  format: 'cjs', platform: 'browser', target: 'es2022',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'text' },
});
await mkdir('plugins/ui/lib', { recursive: true });
await writeFile('plugins/ui/lib/client.js', `window.__ModuleLoader__.load({\n  id: '@harnessstudio/ui',\n  factory(require) {\n    const module = { exports: {} };\n    const exports = module.exports;\n    ${result.outputFiles[0].text}\n    return module.exports;\n  }\n});\n`);
console.log('Studio Host and Client plugins built; upstream source unchanged.');
