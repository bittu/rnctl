import { definePlugin, z } from '@rnctl/sdk';

export default definePlugin({
  name: '@rnctl/plugin-logs',
  version: '0.1.0',
  description: 'Unified native + JS log multiplexing',
  async setup(ctx) {
    // shortcut: log sources are stubbed until Metro/logcat/simctl streams land in Phase 1.
    ctx.bus.on<{ message: string }>('log:entry', (entry) => {
      ctx.logger.debug(entry.message);
    });
    ctx.registerRpc('logs.clear', {
      inputSchema: z.object({}),
      handler: async () => ({ cleared: true }),
    });
  },
});
