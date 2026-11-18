import { definePlugin, z, type DeviceInfo } from '@rnctl/sdk';

interface SimctlDevice {
  name?: string;
  udid?: string;
  state?: string;
  isAvailable?: boolean;
}

/** Parses `xcrun simctl list devices -j` output. */
export function parseSimctl(output: string): DeviceInfo[] {
  const parsed = JSON.parse(output) as { devices?: Record<string, SimctlDevice[]> };
  const devices: DeviceInfo[] = [];
  for (const list of Object.values(parsed.devices ?? {})) {
    for (const device of list) {
      if (!device.udid || device.isAvailable === false) continue;
      devices.push({
        id: device.udid,
        name: device.name ?? device.udid,
        platform: 'ios',
        state: device.state === 'Booted' ? 'booted' : 'shutdown',
      });
    }
  }
  return devices;
}

/** Parses `adb devices -l` output. */
export function parseAdb(output: string): DeviceInfo[] {
  return output.split('\n').slice(1).flatMap((line) => {
    const [serial, state, ...rest] = line.trim().split(/\s+/);
    if (!serial || !state) return [];
    const model = rest.find((token) => token.startsWith('model:'))?.slice('model:'.length);
    return [{
      id: serial,
      name: model ?? serial,
      platform: 'android' as const,
      state: state === 'device' ? ('booted' as const) : ('shutdown' as const),
    }];
  });
}

/** Parses `emulator -list-avds` output. */
export function parseAvds(output: string): DeviceInfo[] {
  return output.split('\n').map((line) => line.trim()).filter(Boolean).map((name) => ({
    id: name,
    name,
    platform: 'android' as const,
    state: 'shutdown' as const,
  }));
}

export default definePlugin({
  name: '@rnctl/plugin-devices',
  version: '0.1.0',
  description: 'Unified iOS simulator and Android emulator lifecycle',
  async setup(ctx) {
    const discover = async (): Promise<DeviceInfo[]> => {
      const devices: DeviceInfo[] = [];

      if (process.platform === 'darwin') {
        try {
          const { stdout } = await ctx.processes.exec('xcrun', ['simctl', 'list', 'devices', '-j']);
          devices.push(...parseSimctl(stdout));
        } catch (error) {
          ctx.logger.debug(`iOS device discovery failed: ${String(error)}`);
        }
      }

      try {
        const { stdout } = await ctx.processes.exec('adb', ['devices', '-l']);
        devices.push(...parseAdb(stdout));
      } catch (error) {
        ctx.logger.debug(`adb device discovery failed: ${String(error)}`);
      }

      try {
        const { stdout } = await ctx.processes.exec('emulator', ['-list-avds']);
        devices.push(...parseAvds(stdout));
      } catch (error) {
        ctx.logger.debug(`AVD discovery failed: ${String(error)}`);
      }

      return devices;
    };

    ctx.registerRpc('devices.list', {
      inputSchema: z.object({}),
      handler: async () => ({ devices: await discover() }),
    });

    ctx.registerCommand({
      name: 'devices',
      description: 'List available simulators and emulators',
      action: async (_args, pluginCtx) => {
        const devices = await discover();
        if (devices.length === 0) {
          pluginCtx.logger.info('No devices discovered.');
          return;
        }
        for (const device of devices) {
          pluginCtx.logger.info(`${device.platform} ${device.state} ${device.name} (${device.id})`);
        }
      },
    });
  },
});
