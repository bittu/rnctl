import { readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Processes } from '@rnctl/sdk';

export const NUKE_TARGETS = [
  'metro-cache',
  'watchman',
  'node_modules',
  'android-build',
  'ios-pods',
  'derived-data',
] as const;
export type NukeTargetId = typeof NUKE_TARGETS[number];

export interface NukeTarget {
  id: NukeTargetId;
  label: string;
  paths: string[];
  command?: { executable: string; args: string[] };
}

export interface NukeRemoval {
  id: NukeTargetId;
  path: string;
  sizeBytes: number;
}

export interface NukePreview {
  removals: NukeRemoval[];
  commands: string[];
  totalBytes: number;
}

export interface NukeResult {
  removed: string[];
  reclaimedBytes: number;
  errors: string[];
}

function targetsFor(cwd: string, platform: string, home: string): NukeTarget[] {
  const root = resolve(cwd);
  const targets: NukeTarget[] = [
    {
      id: 'metro-cache',
      label: 'Metro cache',
      paths: [join(root, 'node_modules', '.cache')],
    },
    {
      id: 'watchman',
      label: 'Watchman watches',
      paths: [],
      command: { executable: 'watchman', args: ['watch-del-all'] },
    },
    {
      id: 'node_modules',
      label: 'node_modules',
      paths: [join(root, 'node_modules')],
    },
    {
      id: 'android-build',
      label: 'Android build output',
      paths: [join(root, 'android', '.gradle'), join(root, 'android', 'build'), join(root, 'android', 'app', 'build')],
    },
    {
      id: 'ios-pods',
      label: 'iOS Pods',
      paths: [join(root, 'ios', 'Pods')],
    },
  ];
  if (platform === 'darwin') {
    targets.push({
      id: 'derived-data',
      label: 'Xcode DerivedData',
      paths: [join(home, 'Library', 'Developer', 'Xcode', 'DerivedData')],
    });
  }
  return targets;
}

function select(requested: NukeTargetId[], cwd: string, platform: string, home: string): NukeTarget[] {
  const allowed = new Map(targetsFor(cwd, platform, home).map((target) => [target.id, target]));
  return requested.flatMap((id) => {
    const target = allowed.get(id);
    return target ? [target] : [];
  });
}

/** Recursively sums file sizes, with a hard cap so nuke preview stays fast. */
function sizeOf(path: string, remaining = { count: 20000 }): number {
  if (remaining.count <= 0) return 0;
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) return stat.size;
    let total = 0;
    for (const entry of readdirSync(path)) {
      remaining.count -= 1;
      if (remaining.count <= 0) break;
      total += sizeOf(join(path, entry), remaining);
    }
    return total;
  } catch {
    return 0;
  }
}

function isSafe(path: string, cwd: string, home: string): boolean {
  const root = resolve(cwd);
  const resolved = resolve(path);
  if (resolved === root) return false;
  if (resolved.startsWith(`${root}${sep}`)) return true;
  return resolved === join(home, 'Library', 'Developer', 'Xcode', 'DerivedData');
}

export function listTargets(cwd: string, platform: string, home = homedir()): Array<NukeTarget & { sizeBytes: number }> {
  return targetsFor(cwd, platform, home).map((target) => ({
    ...target,
    sizeBytes: target.paths.reduce((total, path) => total + sizeOf(path), 0),
  }));
}

export function previewNuke(
  requested: NukeTargetId[],
  cwd: string,
  platform: string,
  home = homedir(),
): NukePreview {
  const removals: NukeRemoval[] = [];
  const commands: string[] = [];
  for (const target of select(requested, cwd, platform, home)) {
    for (const path of target.paths) {
      if (!isSafe(path, cwd, home)) continue;
      removals.push({ id: target.id, path, sizeBytes: sizeOf(path) });
    }
    if (target.command) {
      commands.push([target.command.executable, ...target.command.args].join(' '));
    }
  }
  return {
    removals,
    commands,
    totalBytes: removals.reduce((total, removal) => total + removal.sizeBytes, 0),
  };
}

export async function runNuke(
  requested: NukeTargetId[],
  confirm: boolean,
  processes: Processes,
  cwd: string,
  platform: string,
  home = homedir(),
): Promise<NukeResult> {
  const result: NukeResult = { removed: [], reclaimedBytes: 0, errors: [] };
  if (!confirm) {
    result.errors.push('Confirmation required: pass confirm: true');
    return result;
  }

  const plan = previewNuke(requested, cwd, platform, home);
  for (const removal of plan.removals) {
    try {
      await rm(removal.path, { recursive: true, force: true });
      result.removed.push(removal.path);
      result.reclaimedBytes += removal.sizeBytes;
    } catch (error) {
      result.errors.push(`${removal.path}: ${String(error)}`);
    }
  }

  for (const command of plan.commands) {
    try {
      const [executable, ...args] = command.split(' ');
      const outcome = await processes.exec(executable, args);
      if (outcome.exitCode === 0) result.removed.push(command);
      else result.errors.push(`${command}: ${outcome.stderr.trim() || `exit ${outcome.exitCode}`}`);
    } catch (error) {
      result.errors.push(`${command}: ${String(error)}`);
    }
  }

  return result;
}
