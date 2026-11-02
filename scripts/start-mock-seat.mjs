import { join } from 'node:path';
import { root } from './prepare.mjs';
import { startMockSeat } from './mock-seat-process.mjs';

const platform = await startMockSeat(process.env.STUDIO_HOME || join(root, '.studio/home'));
console.log(`Mock Seat ready at ${platform.url}`);
console.log('Private service credential: <STUDIO_HOME>/mock-seat/token');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void platform.stop(); });
platform.child.on('exit', code => { process.exitCode = code ?? 1; });
