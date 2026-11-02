#!/usr/bin/env node
// harnessstudio run: started by bin/harnessstudio inside the cli image (cli/设计.md §7.1), or directly with node for development.
import { main } from '../src/main.ts';

const listeners: (() => void)[] = [];
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { for (const listener of listeners) listener(); });
const code = await main({
  argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr,
  signals: { on: listener => { listeners.push(listener); } },
  exit: code => process.exit(code),
});
process.exitCode = code;
