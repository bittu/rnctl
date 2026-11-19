import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Processes } from '@rnctl/sdk';
import { describe, expect, it, vi } from 'vitest';
import { previewNuke, runNuke } from './nuke.js';

describe('nuke', () => {
  it('previews only whitelisted, in-project paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'rnctl-nuke-preview-'));
    try {
      mkdirSync(join(root, 'node_modules', '.cache', 'metro'), { recursive: true });
      writeFileSync(join(root, 'node_modules', '.cache', 'metro', 'bundle'), 'x'.repeat(2048));

      const plan = previewNuke(['metro-cache', 'node_modules'], root, 'linux');
      expect(plan.removals.map((removal) => removal.path)).toEqual([
        join(root, 'node_modules', '.cache'),
        join(root, 'node_modules'),
      ]);
      expect(plan.totalBytes).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to delete without confirmation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rnctl-nuke-confirm-'));
    try {
      mkdirSync(join(root, 'node_modules'), { recursive: true });
      const processes = { exec: vi.fn() } as unknown as Processes;
      const result = await runNuke(['node_modules'], false, processes, root, 'linux');
      expect(result.removed).toEqual([]);
      expect(result.errors[0]).toContain('Confirmation required');
      expect(existsSync(join(root, 'node_modules'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes confirmed targets and reports reclaimed bytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rnctl-nuke-run-'));
    try {
      mkdirSync(join(root, 'node_modules', '.cache'), { recursive: true });
      writeFileSync(join(root, 'node_modules', '.cache', 'bundle'), 'x'.repeat(4096));
      const processes = { exec: vi.fn() } as unknown as Processes;

      const result = await runNuke(['metro-cache'], true, processes, root, 'linux');
      expect(result.removed).toEqual([join(root, 'node_modules', '.cache')]);
      expect(result.reclaimedBytes).toBeGreaterThanOrEqual(4096);
      expect(existsSync(join(root, 'node_modules', '.cache'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs watchman through the process gateway', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rnctl-nuke-watchman-'));
    try {
      const exec = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
      const processes = { exec } as unknown as Processes;
      const result = await runNuke(['watchman'], true, processes, root, 'linux');
      expect(exec).toHaveBeenCalledWith('watchman', ['watch-del-all']);
      expect(result.removed).toContain('watchman watch-del-all');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
