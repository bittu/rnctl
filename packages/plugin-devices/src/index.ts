import { definePlugin, z } from '@rnctl/sdk';

export default definePlugin({
  name: '@rnctl/plugin-devices',
  version: '0.1.0',
  description: 'Unified iOS simulator and Android emulator lifecycle',
  async setup(ctx) {
    // shortcut: discovery is stubbed until xcrun/adb adapters land in Phase 1.
    ctx.registerRpc('devices.list', {
      inputSchema: z.object({}),
      handler: async () => ({ devices: [] }),
    });
    ctx.registerCommand({
      name: 'devices',
      description: 'List available simulators and emulators',
      action: async (_args, pluginCtx) => {
        pluginCtx.logger.info('No devices discovered yet.');
      },
    });
  },
});
