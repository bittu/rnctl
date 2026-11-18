import { definePlugin, z } from '@rnctl/sdk';

export default definePlugin({
  name: '@rnctl/plugin-metro',
  version: '0.1.0',
  description: 'Metro bundler and app build supervision',
  async setup(ctx) {
    // shortcut: bundler control is stubbed until execa wiring lands in Phase 1.
    ctx.registerRpc('metro.start', {
      inputSchema: z.object({ resetCache: z.boolean().default(false) }),
      handler: async ({ resetCache }) => ({ started: false, resetCache }),
    });
    ctx.registerRpc('metro.stop', {
      inputSchema: z.object({}),
      handler: async () => ({ stopped: true }),
    });
  },
});
