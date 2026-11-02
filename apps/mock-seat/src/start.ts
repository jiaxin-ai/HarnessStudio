import { createMockSeatServer, type MockSeatServer } from './server.ts';
import { resolve } from 'node:path';

/** Shared startup only; each image entrypoint pins its own installed profile. */
export async function startMockSeatCli(pinnedImageIds?: string[]): Promise<MockSeatServer> {
  const token = process.env.STUDIO_MOCK_SEAT_TOKEN;
  if (!token) throw new Error('STUDIO_MOCK_SEAT_TOKEN is required.');
  const host = process.env.STUDIO_MOCK_SEAT_HOST || '127.0.0.1';
  const port = Number(process.env.STUDIO_MOCK_SEAT_PORT || 53984);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid STUDIO_MOCK_SEAT_PORT.');
  const maxSeats = Number(process.env.STUDIO_MOCK_SEAT_MAX_SEATS || 16);
  if (!Number.isSafeInteger(maxSeats) || maxSeats < 1 || maxSeats > 100) throw new Error('Invalid STUDIO_MOCK_SEAT_MAX_SEATS.');
  const configured = process.env.STUDIO_MOCK_SEAT_IMAGES?.split(',').map(value => value.trim());
  if (pinnedImageIds && configured && (configured.length !== pinnedImageIds.length || configured.some(value => !pinnedImageIds.includes(value)))) throw new Error('This image entrypoint cannot enable another Mock software profile.');
  const defaultRoot = pinnedImageIds?.length === 1 ? `.studio/mock-seat/${pinnedImageIds[0]}` : '.studio/mock-seat';
  const server = createMockSeatServer({ dataRoot: resolve(process.env.STUDIO_MOCK_SEAT_ROOT || defaultRoot), token, maxSeats, imageIds: pinnedImageIds ?? configured });
  await server.ready;
  await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(port, host, ready); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock Seat listening address unavailable.');
  console.log(`Mock Seat ready at http://${host.includes(':') ? `[${host}]` : host}:${address.port}`);
  server.on('error', () => { console.error('Mock Seat service could not listen.'); process.exitCode = 1; });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (stopping) return; stopping = true; server.close(error => { if (error) process.exitCode = 1; }); });
  return server;
}
