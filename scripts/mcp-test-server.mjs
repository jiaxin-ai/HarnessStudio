// A small Streamable HTTP MCP server for testing Studio's MCP page: one engineering tool and a bearer check.
// Usage: node scripts/mcp-test-server.mjs [host] [port] [token]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-mcp-client/package.json'));
const { createMcpHandler, McpServer } = await import(require.resolve('@modelcontextprotocol/server'));
const { toNodeHandler } = await import(require.resolve('@modelcontextprotocol/node'));
const { z } = await import(require.resolve('zod'));

export async function startMcpTestServer({ host = '127.0.0.1', port = 0, token } = {}) {
  const calls = [];
  const handler = createMcpHandler(() => {
    const mcp = new McpServer({ name: 'studio-mcp-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    mcp.registerTool('gear_center_distance', {
      description: 'Center distance of a spur gear pair: a = m(z1+z2)/2, in mm.',
      inputSchema: z.object({ module: z.number().describe('Module m in mm'), z1: z.number().describe('Teeth of gear 1'), z2: z.number().describe('Teeth of gear 2') }),
    }, async args => { calls.push(args); return { content: [{ type: 'text', text: `中心距 a = ${args.module * (args.z1 + args.z2) / 2} mm（MCP 测试服务计算）` }] }; });
    return mcp;
  });
  const handle = toNodeHandler(handler);
  const server = createServer((request, response) => {
    if (token && request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}'); return; }
    handle(request, response).catch(error => { response.writeHead(500).end(String(error)); });
  });
  await new Promise(resolve => server.listen(port, host, resolve));
  return { url: `http://${host}:${server.address().port}/mcp`, calls, close: async () => { await handler.close(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').at(-1))) {
  const [host, port, token] = process.argv.slice(2);
  const server = await startMcpTestServer({ host: host || '127.0.0.1', port: Number(port || 0), token });
  console.log(`MCP test server: ${server.url}`);
}
