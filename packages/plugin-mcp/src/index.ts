import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { RpcClient, readDaemonPort } from '@rnctl/core';
import { definePlugin } from '@rnctl/sdk';
import { createToolRunner, TOOLS, type RpcSource } from './tools.js';

function buildServer(source: RpcSource): McpServer {
  const server = new McpServer({ name: 'rnctl', version: '0.1.0' });
  const run = createToolRunner(source);

  for (const tool of TOOLS) {
    server.registerTool(tool.name, {
      title: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
    }, async (args: unknown) => {
      const result = await run(tool.name, args);
      return {
        content: [{ type: 'text' as const, text: result.text }],
        isError: result.isError,
      };
    });
  }
  return server;
}

async function startHttp(source: RpcSource): Promise<void> {
  const transports = new Set<StreamableHTTPServerTransport>();
  const http = createServer((request, response) => {
    void (async () => {
      try {
        const path = (request.url ?? '/').split('?')[0];
        if (path !== '/mcp') {
          response.writeHead(404);
          response.end();
          return;
        }
        if (request.method !== 'POST' && request.method !== 'GET' && request.method !== 'DELETE') {
          response.writeHead(405);
          response.end();
          return;
        }

        let body: unknown;
        if (request.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk as Buffer);
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          } catch {
            response.writeHead(400);
            response.end('Invalid JSON');
            return;
          }
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        transports.add(transport);
        transport.onclose = () => { transports.delete(transport); };
        const server = buildServer(source);
        await server.connect(transport);
        await transport.handleRequest(request, response, body);
      } catch (error) {
        console.error(`MCP HTTP request failed: ${String(error)}`);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    })();
  });

  await new Promise<void>((resolve) => { http.listen(0, '127.0.0.1', resolve); });
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const dir = join(homedir(), '.rnctl');
  const portFile = join(dir, 'mcp.json');
  mkdirSync(dir, { recursive: true });
  writeFileSync(portFile, JSON.stringify({ port, url: `http://127.0.0.1:${port}/mcp` }));
  console.error(`rnctl MCP listening on http://127.0.0.1:${port}/mcp`);

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  for (const transport of transports) await transport.close();
  await new Promise<void>((resolve) => { http.close(() => resolve()); });
  try { unlinkSync(portFile); } catch { /* already removed */ }
}

export default definePlugin({
  name: '@rnctl/plugin-mcp',
  version: '0.1.0',
  description: 'Local Model Context Protocol server for AI coding agents',
  async setup(ctx) {
    // shortcut: stdio is the default; --http adds a local-only Streamable HTTP endpoint.
    ctx.registerCommand({
      name: 'mcp',
      description: 'Start a local MCP server (--http for Streamable HTTP)',
      action: async (args) => {
        let source: RpcSource = ctx;
        let client: RpcClient | undefined;
        const port = readDaemonPort();
        if (port !== undefined) {
          try {
            client = await RpcClient.connect(port);
            source = client;
          } catch {
            client = undefined;
          }
        }

        try {
          if (args.includes('--http')) {
            await startHttp(source);
            return;
          }

          const server = buildServer(source);
          const transport = new StdioServerTransport();
          await server.connect(transport);
          await new Promise<void>((resolve) => {
            transport.onclose = () => resolve();
            process.once('SIGINT', resolve);
            process.once('SIGTERM', resolve);
          });
          await server.close();
        } finally {
          client?.close();
        }
      },
    });
  },
});
