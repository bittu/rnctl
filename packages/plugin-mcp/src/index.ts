import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { definePlugin } from '@rnctl/sdk';
import { createToolRunner, TOOLS } from './tools.js';

export default definePlugin({
  name: '@rnctl/plugin-mcp',
  version: '0.1.0',
  description: 'Local Model Context Protocol server for AI coding agents',
  async setup(ctx) {
    // shortcut: stdio only; Streamable HTTP is deferred until multiple clients need one daemon.
    ctx.registerCommand({
      name: 'mcp',
      description: 'Start a local MCP server over stdio',
      action: async () => {
        const server = new McpServer({ name: 'rnctl', version: '0.1.0' });
        const run = createToolRunner(ctx);

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

        const transport = new StdioServerTransport();
        await server.connect(transport);
        await new Promise<void>((resolve) => {
          transport.onclose = () => resolve();
          process.once('SIGINT', resolve);
          process.once('SIGTERM', resolve);
        });
        await server.close();
      },
    });
  },
});
