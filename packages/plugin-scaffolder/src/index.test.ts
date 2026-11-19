import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginContext } from '@rnctl/sdk';
import { describe, expect, it, vi } from 'vitest';
import plugin from './index.js';

function setup() {
  let command: { action: (args: string[], ctx: PluginContext) => Promise<void> } | undefined;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx = {
    bus: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), onAny: vi.fn() },
    logger,
    processes: { spawn: vi.fn(), exec: vi.fn(), stop: vi.fn(), write: vi.fn(), isRunning: vi.fn() },
    registerRpc: vi.fn(),
    registerCommand: (value: { name: string; action: (args: string[], ctx: PluginContext) => Promise<void> }) => {
      command = value;
    },
  } as unknown as PluginContext;
  return { ctx, logger, getCommand: () => command! };
}

describe('plugin scaffolder', () => {
  it('creates a publishable plugin package', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rnctl-scaffold-'));
    const { ctx, getCommand } = setup();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      await plugin.setup(ctx);
      await getCommand().action(['create', 'demo'], ctx);

      const dir = join(root, 'rnctl-plugin-demo');
      expect(existsSync(join(dir, 'package.json'))).toBe(true);
      expect(existsSync(join(dir, 'src', 'index.ts'))).toBe(true);
      expect(existsSync(join(dir, 'src', 'index.test.ts'))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))).toMatchObject({
        name: 'rnctl-plugin-demo',
        publishConfig: { access: 'public' },
      });
      expect(readFileSync(join(dir, 'src', 'index.ts'), 'utf8')).toContain("'demo.ping'");
    } finally {
      cwdSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses invalid names and existing directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rnctl-scaffold-'));
    const { ctx, logger, getCommand } = setup();
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      await plugin.setup(ctx);
      await getCommand().action(['create', 'Bad_Name'], ctx);
      expect(logger.error).toHaveBeenCalled();

      await getCommand().action(['create', 'demo'], ctx);
      await getCommand().action(['create', 'demo'], ctx);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Refusing to overwrite'));
    } finally {
      cwdSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
