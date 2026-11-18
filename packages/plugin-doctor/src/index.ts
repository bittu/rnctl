import { definePlugin, z } from '@rnctl/sdk';

export default definePlugin({
  name: '@rnctl/plugin-doctor',
  version: '0.1.0',
  description: 'Environment diagnostics and cache cleanup',
  async setup(ctx) {
    // shortcut: checks are stubbed until environment probes land in Phase 2.
    ctx.registerRpc('doctor.check', {
      inputSchema: z.object({}),
      handler: async () => ({ healthy: true, checks: [] }),
    });
    ctx.registerCommand({
      name: 'nuke',
      description: 'Clean caches and build artifacts',
      action: async (_args, pluginCtx) => {
        pluginCtx.logger.info('Cache cleanup is not implemented yet.');
      },
    });
  },
});
