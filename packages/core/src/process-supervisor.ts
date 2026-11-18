import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import type {
  ExecResult,
  ProcessExit,
  ProcessHandle,
  ProcessOutput,
  Processes,
  SpawnOptions,
} from '@rnctl/sdk';

export type ProcessEmitter = (topic: string, payload: unknown) => void;

/** Owns every spawned child process so the daemon can stop them all on exit. */
export class ProcessSupervisor implements Processes {
  private readonly handles = new Map<string, ChildProcess>();

  constructor(private readonly emit: ProcessEmitter = () => {}) {}

  async spawn(id: string, command: string, args: string[] = [], options: SpawnOptions = {}): Promise<ProcessHandle> {
    if (this.handles.has(id)) {
      throw new Error(`Process "${id}" is already registered`);
    }

    const child = spawnChild(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.handles.set(id, child);

    child.stdout?.on('data', (chunk: Buffer) => {
      this.emit('process:stdout', { id, chunk: chunk.toString() } satisfies ProcessOutput);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.emit('process:stderr', { id, chunk: chunk.toString() } satisfies ProcessOutput);
    });
    child.once('exit', (code, signal) => {
      this.handles.delete(id);
      this.emit('process:exit', { id, code, signal } satisfies ProcessExit);
    });
    child.once('error', () => {
      this.handles.delete(id);
    });
    child.unref();

    return { id, pid: child.pid };
  }

  async exec(command: string, args: string[] = [], options: SpawnOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawnChild(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
    });
  }

  async stop(id: string, signal = 'SIGTERM'): Promise<void> {
    const child = this.handles.get(id);
    if (!child || child.exitCode !== null) {
      this.handles.delete(id);
      return;
    }
    child.kill(signal as NodeJS.Signals);
  }

  get(id: string): ProcessHandle | undefined {
    const child = this.handles.get(id);
    return child ? { id, pid: child.pid } : undefined;
  }

  list(): ProcessHandle[] {
    return [...this.handles.entries()].map(([id, child]) => ({ id, pid: child.pid }));
  }

  /** Terminates every tracked child, escalating to SIGKILL for survivors. */
  async shutdown(graceMs = 2000): Promise<void> {
    const children = [...this.handles.values()];
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    if (children.length === 0) return;

    await Promise.race([
      Promise.all(children.map((child) => new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
      }))),
      new Promise<void>((resolve) => { setTimeout(resolve, graceMs); }),
    ]);

    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    this.handles.clear();
  }
}
