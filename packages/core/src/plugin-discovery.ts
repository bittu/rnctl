import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RnctlPlugin } from '@rnctl/sdk';

function isPlugin(value: unknown): value is RnctlPlugin {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RnctlPlugin>;
  return typeof candidate.name === 'string' && typeof candidate.setup === 'function';
}

async function loadFrom(dir: string): Promise<RnctlPlugin[]> {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { main?: string };
    const url = pathToFileURL(join(dir, pkg.main ?? 'index.js')).href;
    const module = await import(url) as { default?: unknown };
    return isPlugin(module.default) ? [module.default] : [];
  } catch {
    return [];
  }
}

/** Discovers community plugins named rnctl-plugin-* in a project's node_modules. */
export async function discoverPlugins(cwd: string = process.cwd()): Promise<RnctlPlugin[]> {
  const modules = join(cwd, 'node_modules');
  let entries: string[];
  try {
    entries = readdirSync(modules);
  } catch {
    return [];
  }

  const found: RnctlPlugin[] = [];
  for (const entry of entries) {
    if (entry.startsWith('rnctl-plugin-')) {
      found.push(...await loadFrom(join(modules, entry)));
      continue;
    }
    if (!entry.startsWith('@')) continue;
    let scoped: string[];
    try {
      scoped = readdirSync(join(modules, entry));
    } catch {
      continue;
    }
    for (const name of scoped) {
      if (name.startsWith('rnctl-plugin-')) found.push(...await loadFrom(join(modules, entry, name)));
    }
  }
  return found;
}
