import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePlugin, z, type PluginContext } from '@rnctl/sdk';

type Platform = 'ios' | 'android';
interface Target { id: string; platform: Platform; isEmulator: boolean }
export interface TweakResult {
  id: string;
  platform: Platform;
  ok: boolean;
  message: string;
  status: 'applied' | 'unavailable' | 'error';
}

export const commands = {
  iosLocation: (id: string, lat: number, lon: number) => ['simctl', 'location', id, 'set', `${lat},${lon}`],
  iosAppearance: (id: string, mode: 'dark' | 'light') => ['simctl', 'ui', id, 'appearance', mode],
  iosStatusBar: (id: string, args: string[]) => ['simctl', 'status_bar', id, 'override', ...args],
  iosPush: (id: string, bundleId: string, payloadPath: string) => ['simctl', 'push', id, bundleId, payloadPath],
  androidGeo: (id: string, lat: number, lon: number) => ['emu', 'geo', 'fix', String(lon), String(lat)],
  androidAppearance: (id: string, mode: 'dark' | 'light') => ['shell', 'cmd', 'uimode', 'night', mode === 'dark' ? 'yes' : 'no'],
  androidBattery: (id: string, level: number) => ['shell', 'dumpsys', 'battery', 'set', 'level', String(level)],
  androidNetwork: (id: string, profile: string) => ['emu', 'network', 'speed', profile],
  iosReset: (id: string, what: string) => {
    if (what === 'location') return ['simctl', 'location', id, 'clear'];
    if (what === 'statusBar') return ['simctl', 'status_bar', id, 'clear'];
    if (what === 'appearance') return ['simctl', 'ui', id, 'appearance', 'light'];
    return ['simctl', 'status_bar', id, 'clear'];
  },
  androidReset: (id: string, what: string) => {
    if (what === 'network') return ['emu', 'network', 'speed', 'full'];
    if (what === 'battery') return ['shell', 'dumpsys', 'battery', 'reset'];
    if (what === 'appearance') return ['shell', 'cmd', 'uimode', 'night', 'no'];
    return ['shell', 'dumpsys', 'battery', 'reset'];
  },
};

async function booted(ctx: PluginContext): Promise<Target[]> {
  const targets: Target[] = [];
  try {
    const { stdout } = await ctx.processes.exec('adb', ['devices', '-l']);
    for (const line of stdout.split('\n').slice(1)) {
      const [id, state] = line.trim().split(/\s+/);
      if (id && state === 'device') targets.push({ id, platform: 'android', isEmulator: id.startsWith('emulator-') });
    }
  } catch { /* adb unavailable */ }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await ctx.processes.exec('xcrun', ['simctl', 'list', 'devices', '-j']);
      const parsed = JSON.parse(stdout) as {
        devices?: Record<string, Array<{ udid?: string; state?: string; isAvailable?: boolean }>>;
      };
      for (const list of Object.values(parsed.devices ?? {})) {
        for (const device of list) {
          if (device.udid && device.state === 'Booted' && device.isAvailable !== false) {
            targets.push({ id: device.udid, platform: 'ios', isEmulator: true });
          }
        }
      }
    } catch { /* simctl unavailable */ }
  }
  return targets;
}

export default definePlugin({
  name: '@rnctl/plugin-simulator-tweaks',
  version: '0.1.0',
  description: 'Simulator and emulator environment tweaks',
  async setup(ctx) {
    // shortcut: Android mock push needs root/FCM credentials; custom GPS routes need newer simctl flags.
    const targetInput = z.object({ id: z.string(), platform: z.enum(['ios', 'android']).optional() });
    const find = async (id: string, platform?: Platform): Promise<Target | undefined> =>
      (await booted(ctx)).find((device) => device.id === id && (!platform || device.platform === platform));

    const apply = async (
      target: Target | undefined,
      build: (target: Target) => { executable: string; args: string[] },
      kind: string,
    ): Promise<TweakResult> => {
      if (!target) {
        return { id: 'unknown', platform: 'ios', ok: false, message: 'Device is not booted', status: 'unavailable' };
      }
      const { executable, args } = build(target);
      try {
        const result = await ctx.processes.exec(executable, args);
        const message = (result.stderr || result.stdout).trim().split('\n')[0] ?? 'ok';
        const tweak: TweakResult = {
          id: target.id,
          platform: target.platform,
          ok: result.exitCode === 0,
          message: message.slice(0, 160) || 'ok',
          status: result.exitCode === 0 ? 'applied' : 'error',
        };
        if (tweak.ok) void ctx.bus.emit('tweak:applied', { kind, ...tweak });
        return tweak;
      } catch (error) {
        return { id: target.id, platform: target.platform, ok: false, message: String(error), status: 'error' };
      }
    };

    ctx.registerRpc('tweaks.devices', {
      inputSchema: z.object({}),
      handler: async () => ({ devices: await booted(ctx) }),
    });

    ctx.registerRpc('tweaks.location.set', {
      inputSchema: targetInput.extend({
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
      }),
      handler: async ({ id, platform, lat, lon }) => {
        const target = await find(id, platform);
        if (target?.platform === 'android' && !target.isEmulator) {
          return { id, platform: 'android', ok: false, status: 'unavailable', message: 'GPS injection is emulator-only' };
        }
        return apply(target, (device) => device.platform === 'ios'
          ? { executable: 'xcrun', args: commands.iosLocation(device.id, lat, lon) }
          : { executable: 'adb', args: ['-s', device.id, ...commands.androidGeo(device.id, lat, lon)] }, 'location');
      },
    });

    ctx.registerRpc('tweaks.appearance.set', {
      inputSchema: targetInput.extend({ mode: z.enum(['dark', 'light']) }),
      handler: async ({ id, platform, mode }) => apply(await find(id, platform), (device) => device.platform === 'ios'
        ? { executable: 'xcrun', args: commands.iosAppearance(device.id, mode) }
        : { executable: 'adb', args: ['-s', device.id, ...commands.androidAppearance(device.id, mode)] }, 'appearance'),
    });

    ctx.registerRpc('tweaks.statusBar.set', {
      inputSchema: targetInput.extend({
        time: z.string().optional(),
        batteryLevel: z.number().int().min(0).max(100).optional(),
        preset: z.literal('clean').optional(),
      }),
      handler: async ({ id, platform, time, batteryLevel, preset }) => {
        const target = await find(id, platform);
        if (target && target.platform !== 'ios') {
          return { id, platform: 'android', ok: false, status: 'unavailable', message: 'Status bar overrides are iOS-only' };
        }
        const args: string[] = [];
        if (preset === 'clean' || time) args.push('--time', time ?? '9:41');
        if (preset === 'clean' || batteryLevel !== undefined) {
          args.push('--batteryState', 'charged', '--batteryLevel', String(batteryLevel ?? 100));
        }
        if (preset === 'clean') args.push('--cellularMode', 'active', '--cellularBars', '4', '--wifiMode', 'active', '--wifiBars', '3');
        return apply(target, (device) => ({ executable: 'xcrun', args: commands.iosStatusBar(device.id, args) }), 'statusBar');
      },
    });

    ctx.registerRpc('tweaks.network.set', {
      inputSchema: targetInput.extend({ profile: z.enum(['gsm', 'edge', 'umts', 'hsdpa', 'lte', 'full']) }),
      handler: async ({ id, platform, profile }) => {
        const target = await find(id, platform);
        if (target && (target.platform !== 'android' || !target.isEmulator)) {
          return { id, platform: target?.platform ?? 'ios', ok: false, status: 'unavailable', message: 'Network throttle is emulator-only' };
        }
        return apply(target, (device) => ({
          executable: 'adb', args: ['-s', device.id, ...commands.androidNetwork(device.id, profile)],
        }), 'network');
      },
    });

    ctx.registerRpc('tweaks.battery.set', {
      inputSchema: targetInput.extend({ level: z.number().int().min(0).max(100) }),
      handler: async ({ id, platform, level }) => {
        const target = await find(id, platform);
        if (target?.platform === 'ios') {
          return { id, platform: 'ios', ok: false, status: 'unavailable', message: 'Battery override is Android-only' };
        }
        return apply(target, (device) => ({
          executable: 'adb', args: ['-s', device.id, ...commands.androidBattery(device.id, level)],
        }), 'battery');
      },
    });

    ctx.registerRpc('tweaks.push.send', {
      inputSchema: targetInput.extend({ bundleId: z.string(), payload: z.record(z.string(), z.unknown()) }),
      handler: async ({ id, platform, bundleId, payload }) => {
        const target = await find(id, platform);
        if (target && target.platform !== 'ios') {
          return { id, platform: 'android', ok: false, status: 'unavailable', message: 'Mock push is iOS-only in this plugin' };
        }
        const scratch = mkdtempSync(join(tmpdir(), 'rnctl-push-'));
        try {
          const payloadPath = join(scratch, 'payload.apns');
          writeFileSync(payloadPath, JSON.stringify({ 'Simulator Target Bundle': bundleId, ...payload }));
          return await apply(target, (device) => ({
            executable: 'xcrun', args: commands.iosPush(device.id, bundleId, payloadPath),
          }), 'push');
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      },
    });

    ctx.registerRpc('tweaks.reset', {
      inputSchema: targetInput.extend({
        what: z.enum(['location', 'appearance', 'statusBar', 'network', 'battery', 'all']),
      }),
      handler: async ({ id, platform, what }) => {
        const target = await find(id, platform);
        const kinds = what === 'all' ? ['location', 'statusBar', 'appearance', 'network', 'battery'] : [what];
        const results: TweakResult[] = [];
        for (const kind of kinds) {
          const current = await find(id, platform);
          if (!current) break;
          if (current.platform === 'ios' && (kind === 'network' || kind === 'battery')) continue;
          if (current.platform === 'android' && kind === 'statusBar') continue;
          results.push(await apply(current, (device) => ({
            executable: device.platform === 'ios' ? 'xcrun' : 'adb',
            args: device.platform === 'ios'
              ? commands.iosReset(device.id, kind)
              : ['-s', device.id, ...commands.androidReset(device.id, kind)],
          }), `reset:${kind}`));
          void ctx.bus.emit('tweak:reset', { id, kind });
        }
        return { results, ok: results.every((result) => result.ok) };
      },
    });
  },
});
