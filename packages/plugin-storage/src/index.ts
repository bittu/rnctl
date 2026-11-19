import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { definePlugin, z, type PluginContext } from '@rnctl/sdk';

export interface StorageApp {
  id: string;
  platform: 'ios' | 'android';
}

export interface StorageSource {
  id: string;
  kind: 'asyncstorage-json' | 'asyncstorage-sqlite' | 'sqlite' | 'mmkv';
  path: string;
  available: boolean;
  reason?: string;
}

export interface StorageEntry {
  key: string;
  value: string;
}

/** Extracts bundle identifiers from `simctl listapps` plist output. */
export function parseIosApps(output: string): string[] {
  const ids = new Set<string>();
  for (const line of output.split('\n')) {
    const match = line.match(/"?CFBundleIdentifier"?\s*=\s*"([^"]+)"/);
    if (match && !match[1].startsWith('com.apple.')) ids.add(match[1]);
  }
  return [...ids];
}

export function parseAndroidApps(output: string): string[] {
  return output.split('\n')
    .map((line) => line.trim().replace(/^package:/, ''))
    .filter((line) => line.includes('.'));
}

function walkFiles(root: string, suffix: string, max = 200): string[] {
  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 5 || found.length >= max || !existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      try {
        if (statSync(path).isDirectory()) visit(path, depth + 1);
        else if (path.endsWith(suffix)) found.push(path);
      } catch { /* unreadable entry */ }
    }
  };
  visit(root, 0);
  return found;
}

function sqlEntries(path: string, limit: number): StorageEntry[] {
  const scratch = mkdtempSync(join(tmpdir(), 'rnctl-storage-'));
  try {
    const copy = join(scratch, 'store.sqlite');
    copyFileSync(path, copy);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      for (const table of ['Storage', 'catalystLocalStorage']) {
        try {
          const rows = db.prepare(`SELECT key, value FROM ${table} LIMIT ?`).all(limit) as Array<{ key: string; value: string }>;
          return rows.map((row) => ({ key: String(row.key), value: String(row.value) }));
        } catch { /* try next known table */ }
      }
      return [];
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export default definePlugin({
  name: '@rnctl/plugin-storage',
  version: '0.1.0',
  description: 'Read AsyncStorage and SQLite from app containers',
  async setup(ctx: PluginContext) {
    // shortcut: MMKV and write-back are unsupported; encrypted MMKV needs an app-provided key.
    const firstDevice = async (): Promise<string | undefined> => {
      const { stdout } = await ctx.processes.exec('adb', ['devices', '-l']);
      return stdout.split('\n').slice(1).map((line) => line.trim().split(/\s+/)[0]).find(Boolean);
    };

    ctx.registerRpc('storage.apps', {
      inputSchema: z.object({}),
      handler: async () => {
        const apps: StorageApp[] = [];
        if (process.platform === 'darwin') {
          try {
            const { stdout } = await ctx.processes.exec('xcrun', ['simctl', 'listapps', 'booted']);
            apps.push(...parseIosApps(stdout).map((id) => ({ id, platform: 'ios' as const })));
          } catch { /* no booted simulator */ }
        }
        try {
          const { stdout } = await ctx.processes.exec('adb', ['shell', 'pm', 'list', 'packages', '-3']);
          apps.push(...parseAndroidApps(stdout).map((id) => ({ id, platform: 'android' as const })));
        } catch { /* no adb device */ }
        return { apps };
      },
    });

    ctx.registerRpc('storage.sources', {
      inputSchema: z.object({ app: z.string(), platform: z.enum(['ios', 'android']) }),
      handler: async ({ app, platform }) => {
        const sources: StorageSource[] = [];
        if (platform === 'ios') {
          if (process.platform !== 'darwin') return { sources };
          const { stdout } = await ctx.processes.exec('xcrun', ['simctl', 'get_app_container', 'booted', app, 'data']);
          const root = stdout.trim();
          const legacy = join(root, 'Library', 'Application Support', app, 'RCTAsyncLocalStorage_V1', 'manifest.json');
          if (existsSync(legacy)) sources.push({ id: legacy, kind: 'asyncstorage-json', path: legacy, available: true });
          for (const path of walkFiles(join(root, 'Library', 'Application Support', 'async-storage'), '.sqlite')) {
            sources.push({ id: path, kind: 'asyncstorage-sqlite', path, available: true });
          }
          for (const path of walkFiles(join(root, 'Documents', 'mmkv'), '.default')) {
            sources.push({
              id: path, kind: 'mmkv', path, available: false,
              reason: 'MMKV reading requires a parser and possibly an encryption key',
            });
          }
          for (const path of walkFiles(join(root, 'Documents'), '.db')) {
            sources.push({ id: path, kind: 'sqlite', path, available: true });
          }
          return { sources };
        }

        const device = await firstDevice();
        if (!device) return { sources };
        const { stdout } = await ctx.processes.exec('adb', ['-s', device, 'shell', 'run-as', app, 'ls', '-R', `/data/data/${app}`]);
        const remote = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
        for (const path of remote) {
          if (path.endsWith('AsyncStorage') || path.endsWith('RKStorage')) {
            sources.push({ id: path, kind: 'asyncstorage-sqlite', path, available: true });
          } else if (path.includes('async-storage') && path.endsWith('.sqlite')) {
            sources.push({ id: path, kind: 'asyncstorage-sqlite', path, available: true });
          } else if (path.includes('/mmkv/')) {
            sources.push({
              id: path, kind: 'mmkv', path, available: false,
              reason: 'MMKV reading requires a parser and possibly an encryption key',
            });
          } else if (path.endsWith('.db')) {
            sources.push({ id: path, kind: 'sqlite', path, available: true });
          }
        }
        return { sources };
      },
    });

    ctx.registerRpc('storage.read', {
      inputSchema: z.object({
        app: z.string(),
        platform: z.enum(['ios', 'android']),
        source: z.string(),
        kind: z.enum(['asyncstorage-json', 'asyncstorage-sqlite', 'sqlite', 'mmkv']),
        limit: z.number().int().positive().default(100),
      }),
      handler: async ({ app, platform, source, kind, limit }) => {
        if (kind === 'mmkv') {
          return { available: false, reason: 'MMKV reading is not supported yet', entries: [] };
        }
        try {
          if (kind === 'asyncstorage-json') {
            const parsed = JSON.parse(readFileSync(source, 'utf8')) as Record<string, string>;
            return {
              available: true,
              entries: Object.entries(parsed).slice(0, limit).map(([key, value]) => ({ key, value })),
            };
          }
          if (platform === 'ios') {
            return { available: true, entries: sqlEntries(source, limit) };
          }
          const device = await firstDevice();
          if (!device) return { available: false, reason: 'No adb device', entries: [] };
          const scratch = mkdtempSync(join(tmpdir(), 'rnctl-storage-'));
          try {
            const staged = `/sdcard/rnctl-storage-${Date.now()}`;
            await ctx.processes.exec('adb', ['-s', device, 'shell', 'run-as', app, 'cp', source, staged]);
            const local = join(scratch, 'store.sqlite');
            await ctx.processes.exec('adb', ['-s', device, 'pull', staged, local]);
            await ctx.processes.exec('adb', ['-s', device, 'shell', 'rm', '-f', staged]);
            return { available: true, entries: sqlEntries(local, limit) };
          } finally {
            rmSync(scratch, { recursive: true, force: true });
          }
        } catch (error) {
          return { available: false, reason: String(error), entries: [] };
        }
      },
    });

    for (const name of ['storage.write', 'storage.clear'] as const) {
      ctx.registerRpc(name, {
        inputSchema: z.object({ app: z.string(), source: z.string() }),
        handler: async () => ({
          available: false,
          reason: 'Storage editing is not supported yet; the explorer is read-only',
        }),
      });
    }
  },
});
