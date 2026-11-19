import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detoxArgs, discoverFlows, maestroArgs } from './index.js';

describe('E2E discovery', () => {
  it('finds Maestro flows but skips config and subflows', () => {
    const root = mkdtempSync(join(tmpdir(), 'rnctl-e2e-'));
    try {
      mkdirSync(join(root, '.maestro', 'subflows'), { recursive: true });
      writeFileSync(join(root, '.maestro', 'login.yaml'), 'appId: com.example');
      writeFileSync(join(root, '.maestro', 'config.yaml'), '{}');
      writeFileSync(join(root, '.maestro', 'subflows', 'helper.yaml'), 'appId: com.example');

      const flows = discoverFlows(root, 'maestro');
      expect(flows.map((flow) => flow.name)).toEqual(['login.yaml']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds Detox test files', () => {
    const root = mkdtempSync(join(tmpdir(), 'rnctl-e2e-'));
    try {
      mkdirSync(join(root, 'e2e'), { recursive: true });
      writeFileSync(join(root, 'e2e', 'login.test.js'), 'describe("login", () => {});');
      writeFileSync(join(root, 'e2e', 'helpers.js'), 'module.exports = {};');
      expect(discoverFlows(root, 'detox').map((flow) => flow.name)).toEqual(['login.test.js']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds runner argument arrays targeting a device', () => {
    expect(maestroArgs('/flows/login.yaml', 'emulator-5554', '/tmp/artifacts')).toEqual([
      '--device', 'emulator-5554', 'test', '--no-ansi',
      '--test-output-dir', '/tmp/artifacts',
      '--format', 'junit', '--output', join('/tmp/artifacts', 'report.xml'),
      '/flows/login.yaml',
    ]);
    expect(detoxArgs('/e2e/login.test.js', 'ios.sim.debug', '/tmp/artifacts')).toContain('--no-install');
  });
});
