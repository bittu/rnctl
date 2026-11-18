import { describe, expect, it } from 'vitest';
import { ProcessSupervisor } from './process-supervisor.js';

const node = process.execPath;
const forever = 'setInterval(() => {}, 1000)';

describe('ProcessSupervisor', () => {
  it('captures stdout, stderr and exit code from exec', async () => {
    const supervisor = new ProcessSupervisor();
    const result = await supervisor.exec(node, [
      '-e',
      "process.stdout.write('out'); process.stderr.write('err');",
    ]);
    expect(result).toEqual({ stdout: 'out', stderr: 'err', exitCode: 0 });
  });

  it('reports non-zero exit codes', async () => {
    const supervisor = new ProcessSupervisor();
    const result = await supervisor.exec(node, ['-e', 'process.exit(3)']);
    expect(result.exitCode).toBe(3);
  });

  it('emits output and exit events for spawned processes', async () => {
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    const events: string[] = [];
    const supervisor = new ProcessSupervisor((topic) => {
      events.push(topic);
      if (topic === 'process:exit') resolveExit();
    });

    const handle = await supervisor.spawn('echo', node, ['-e', "process.stdout.write('hi')"]);
    expect(handle.pid).toBeGreaterThan(0);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);

    expect(events).toContain('process:stdout');
    expect(events).toContain('process:exit');
    expect(supervisor.get('echo')).toBeUndefined();
  });

  it('rejects duplicate process ids', async () => {
    const supervisor = new ProcessSupervisor();
    await supervisor.spawn('dup', node, ['-e', forever]);
    await expect(supervisor.spawn('dup', node, ['-e', ''])).rejects.toThrow(/already registered/);
    await supervisor.shutdown(0);
  });

  it('stops a tracked process on demand', async () => {
    const supervisor = new ProcessSupervisor();
    await supervisor.spawn('long', node, ['-e', forever]);
    expect(supervisor.list()).toHaveLength(1);

    await supervisor.stop('long');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(supervisor.get('long')).toBeUndefined();
  });

  it('terminates every tracked process on shutdown', async () => {
    const supervisor = new ProcessSupervisor();
    await supervisor.spawn('a', node, ['-e', forever]);
    await supervisor.spawn('b', node, ['-e', forever]);

    await supervisor.shutdown(100);
    expect(supervisor.list()).toEqual([]);
  });
});
