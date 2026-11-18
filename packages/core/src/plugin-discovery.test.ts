import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverPlugins } from './plugin-discovery.js';

describe('discoverPlugins', () => {
  it('loads rnctl-plugin-* packages from node_modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rnctl-discovery-'));
    try {
      const pluginDir = join(root, 'node_modules', 'rnctl-plugin-demo');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(
        join(pluginDir, 'package.json'),
        JSON.stringify({ name: 'rnctl-plugin-demo', main: 'index.mjs' }),
      );
      writeFileSync(
        join(pluginDir, 'index.mjs'),
        'export default { name: "rnctl-plugin-demo", version: "1.0.0", async setup() {} };',
      );

      const plugins = await discoverPlugins(root);
      expect(plugins.map((plugin) => plugin.name)).toEqual(['rnctl-plugin-demo']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns nothing when node_modules is absent', async () => {
    expect(await discoverPlugins(join(tmpdir(), 'rnctl-no-such-dir'))).toEqual([]);
  });
});
